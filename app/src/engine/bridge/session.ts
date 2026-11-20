// Mode A bridge session: the robot's clock drives the physics. Each ToApp frame from the robot carries the applied motor
// voltages and the robot's simulation time; the session steps the engine for the elapsed robot time with those voltages
// held, then answers with a FromApp frame (rotor, CANcoder and Pigeon states) carrying the same sequence number.
// Frames and controls travel on the local WebSocket channel; NetworkTables is only listened to for the robot's own
// articulated component poses (what the 3D model draws).
import type { Engine } from '../engine'
import { checkAgainstHello, type RobotDefinition } from '../../robots/definition'
import { decodeStruct } from '../../renderer/src/lib/structs'
import { Nt4Raw } from './nt4raw'
import { DEFAULT_CAMERA, detectTags, estimatePose, NO_VISION, type Detection, type PoseEstimate, type VisionSettings } from '../vision'
import { applyFaults, batteryVoltage, DEFAULT_BATTERY, NO_FAULTS, Noise, type BatteryModel, type Faults } from './faults'
import {
  decodeToApp, encodeDs, encodeFromApp, encodeJoystick, encodePoseSeed, encodeStep, type DsState, type FromApp, type JoystickState, type ToApp,
} from './frames'
import {
  DEFAULT_WS_PORT, MSG_DS, MSG_FROM_APP, MSG_HELLO, MSG_JOYSTICK, MSG_POSE_SEED, MSG_STATS, MSG_STEP, MSG_TO_APP, MSG_VISION, WsTransport,
} from './ws-transport'

const SEED_DELAY_FRAMES = 20
const DEFAULT_LEAD_S = 0.001
const MAX_LEAD_S = 0.02
const MOTOR_FLAG_RESET = 4
const COMPONENTS_TOPIC = '/AdvantageKit/RealOutputs/Mechanism3d/Components'
const MAX_CATCH_UP_S = 0.25 // never simulate more than this per frame (the robot was stalled or paused)

export interface BridgeStatus {
  connected: boolean
  frames: number
  lastSeq: bigint
  /** robot sim time of the last frame */
  robotTime: number
  /** frames in which the robot skipped ahead by more than catch-up allows */
  skipped: number
  robotEnabled: boolean
  helloDevices: string | null
  /** differences between the robot definition and what the robot registered (empty when they agree) */
  helloIssues: string[]
  /** the robot's own articulated component poses (Pose3d x n, flat), for drawing the model */
  components: Float64Array | null
}

export interface BridgePorts {
  /** the bridge WebSocket on the robot (default 5811) */
  ws?: number
  /** the robot's NetworkTables server, for the component poses (null = do not connect) */
  nt?: number | null
}

/** Lockstep (Mode B): the app owns the clock. dt is the simulated time of one exchange; speed is the multiple of real time (0 = as fast as it goes). */
export interface LockstepOptions { dt: number; speed?: number }

/**
 * Message counters tell the robot that a message is new, and the robot ignores a number it has already applied. The robot program outlives the sims the app
 * starts and stops, so a new session must not reuse the numbers of an earlier one: it counts on from the clock (microseconds), which no earlier session reached.
 * (Starting from 0 or 1 made the robot drop the first pose seed of every later session: it kept the position of the sim before, and aimed from there.)
 */
const sessionBase = (): bigint => BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1000))

export class BridgeSession {
  private ws: WsTransport
  private nt: Nt4Raw | null = null
  private lastRobotTime: number | null = null
  private owed = 0
  private ctrlCounter = sessionBase() + 1n
  /** Paused: Mode A stops stepping the engine; lockstep stops sending steps (the robot's clock stands still). */
  get paused(): boolean { return this._paused }
  set paused(v: boolean) { this._paused = v; if (!v) this.resumeLockstep() }
  private _paused = false
  /** Lockstep state: the next Step's sequence number, timed actions, and the wall clock the pacing follows. */
  private lockstep: LockstepOptions | null
  private stepSeq = 0n
  private stepPending = false
  private lockstepStarted = false
  private timeline: { t: number; fn: () => void }[] = []
  private paceWall = 0
  private paceSim = 0
  /** Steps exchanged in lockstep, and wall time spent (for the speed readout). */
  lockstepSteps = 0
  /** The voltage each motor was last told to apply (lockstep), for logs and tests. */
  readonly lastMotorVolts = new Map<number, number>()
  /** Lockstep speed multiple of real time (0 = unlimited). */
  get speed(): number { return this.lockstep?.speed ?? 0 }
  set speed(v: number) { if (this.lockstep) { this.lockstep.speed = v; this.paceWall = 0 } }
  get isLockstep(): boolean { return this.lockstep !== null }
  /** The app is the field system: DS enable, mode, match time and Game Data follow the match phases of the game module. */
  fms = false
  private fmsKey = ''
  /** how far ahead of the physics clock the mechanism states are reported, seconds (follows the measured round trip) */
  lead = DEFAULT_LEAD_S
  /** follow the round trip the robot measures (turn off to set the lead by hand) */
  autoLead = true
  /** the robot's measured round trip of the exchange, seconds (0 until it reports) */
  rtt = 0
  /** things that go wrong (dropped devices, brownout, noise, latency) and the battery that sags under load */
  faults: Faults = { ...NO_FAULTS }
  battery: BatteryModel = { ...DEFAULT_BATTERY }
  private noise = new Noise(1)
  /** the simulated camera: off by default; on, the robot is sent the tags it sees and a noisy pose estimate about 20 times per simulated second */
  vision: VisionSettings = { ...NO_VISION }
  private visionAt = -1
  /** what the camera saw last, for the panel and the 3D view */
  visionReading: { tags: Detection[]; pose: PoseEstimate | null; truth: { x: number; y: number; yaw: number } | null } = { tags: [], pose: null, truth: null }
  /** the battery voltage and current the robot was last told about, for the panel */
  batteryReading = { volts: 12, amps: 0 }
  private ds: DsState = { counter: 0n, gameData: '', enabled: false, autonomous: false, test: false, estop: false, dsAttached: true, alliance: 1, station: 1, matchTime: 0 }
  private joystick: JoystickState = { counter: 0n, axes: [0, 0, 0, 0, 0, 0], buttons: 0n, pov: -1 }
  private poseSeedCounter = sessionBase()
  /** lockstep: a pose seed waits for the next state update (see seedPose) */
  private seedAfterNextState = false
  /** frame count at which a pending pose seed is sent (null when none is pending) */
  private seedAtFrame: number | null = null
  private resetSeen = new Set<number>()
  status: BridgeStatus = { connected: false, frames: 0, lastSeq: 0n, robotTime: 0, skipped: 0, robotEnabled: false, helloDevices: null, helloIssues: [], components: null }

  constructor(private engine: Engine, host: string, ports: BridgePorts = {}, private onStatus: () => void = () => {}, private def: RobotDefinition | null = null, lockstep: LockstepOptions | null = null) {
    this.lockstep = lockstep
    this.ds.alliance = engine.robotAlliance === 'red' ? 0 : 1 // 0 red, 1 blue
    this.ws = new WsTransport(host, ports.ws ?? DEFAULT_WS_PORT)
    this.ws.onMessage = (type, body) => this.onMessage(type, body)
    this.ws.onConnection = (c) => {
      this.status.connected = c
      if (c) {
        this.lastRobotTime = null; this.owed = 0; this.sendDs(); this.sendJoystick()
        if (!this.lockstep) this.seedPose()
        else { this.lockstepStarted = false; this.stepPending = false; this.stepSeq = 0n }
      }
      this.onStatus()
    }
    if (ports.nt !== null) {
      this.nt = new Nt4Raw(host, ports.nt ?? 5810)
      this.nt.subscribeRaw(COMPONENTS_TOPIC, (b) => { this.status.components = decodeStruct('struct:Pose3d[]', b) })
    }
  }

  start(): void { this.ws.start(); this.nt?.start() }

  /** Lockstep: run this at the given simulated time (before the Step that crosses it is sent), so inputs are tied to the sim clock and a run repeats. */
  at(simTime: number, fn: () => void): void {
    this.timeline.push({ t: simTime, fn })
    this.timeline.sort((a, b) => a.t - b.t)
  }

  /** Starts the field system: the match clock is the engine's, so reset the engine first. */
  startMatch(): void { this.fms = true; this.fmsKey = ''; this.updateFms() }

  /** Hands control back: the robot is disabled and the Driver Station buttons work again. */
  endMatch(): void { this.fms = false; this.setDs({ enabled: false, autonomous: false, matchTime: 0, gameData: '' }) }

  /** Drives the Driver Station from the match phases (what FMS does): enabled in AUTO and TELEOP, not in the 3 s between or after the match. */
  private updateFms(): void {
    if (!this.fms) return
    const phase = this.engine.phase
    const t = this.engine.time
    const enabled = phase !== 'delay' && phase !== 'ended' && phase !== 'none'
    const auto = phase === 'auto'
    const matchTime = phase === 'auto' ? 20 - t : phase === 'delay' || phase === 'ended' ? 0 : Math.max(0, 140 - (t - 23))
    const gameData = this.engine.gameData
    const key = `${enabled}|${auto}|${gameData}|${Math.floor(matchTime)}`
    if (key === this.fmsKey) return
    this.fmsKey = key
    this.setDs({ enabled, autonomous: auto, test: false, matchTime, gameData })
  }
  stop(): void { this.ws.stop(); this.nt?.stop(); this.status.connected = false }

  // ---- control from the UI

  setDs(patch: Partial<Omit<DsState, 'counter'>>): void { this.ds = { ...this.ds, ...patch }; this.sendDs() }

  /** axes in the WPILib Xbox layout: 0 LX, 1 LY, 2 LT, 3 RT, 4 RX, 5 RY; buttons as a bitmask (bit 0 = button 1) */
  setJoystick(axes: number[], buttons: bigint, pov: number): void {
    this.joystick = { counter: this.joystick.counter, axes, buttons, pov }
    this.sendJoystick()
  }

  /**
   * Asks the robot to reset its odometry to the engine's robot pose (after a connect, reset or restore). The seed is held
   * back for a few frames so the robot has already seen the new wheel positions: a seed sent first would be followed by a
   * jump in the wheel distances that odometry integrates as motion.
   */
  seedPose(): void {
    // Lockstep: the seed goes out right after the next state update (onToAppLockstep) and before the next step, so it lands at a known step. Sent at once it would
    // reach the robot before the gyro and wheel readings of the new start, and the robot would reset its odometry against the old ones (and then add the difference
    // to its heading: a turret that aims from the wrong angle after every Reset).
    if (this.lockstep) { if (this.lockstepStarted) this.seedAfterNextState = true; return }
    this.seedAtFrame = this.status.frames + SEED_DELAY_FRAMES
  }

  private sendSeed(): void {
    const f = this.engine.getFrame()
    const yaw = 2 * Math.atan2(f.robot[6], f.robot[3])
    this.ws.send(MSG_POSE_SEED, encodePoseSeed({ counter: ++this.poseSeedCounter, x: f.robot[0], y: f.robot[1], yawRad: yaw }))
  }

  private sendDs(): void { this.ds = { ...this.ds, counter: this.ctrlCounter++ }; this.ws.send(MSG_DS, encodeDs(this.ds)) }

  private sendJoystick(): void {
    this.joystick = { ...this.joystick, counter: this.ctrlCounter++ }
    this.ws.send(MSG_JOYSTICK, encodeJoystick(this.joystick))
  }

  // ---- messages from the robot

  private onMessage(type: number, body: Uint8Array): void {
    if (type === MSG_TO_APP) { if (this.lockstep) this.onToAppLockstep(body); else this.onToApp(body) }
    else if (type === MSG_HELLO) {
      const text = new TextDecoder().decode(body)
      this.status.helloDevices = text
      if (this.def) this.status.helloIssues = checkAgainstHello(this.def, text)
      if (this.lockstep && !text.includes('"lockstep"')) this.status.helloIssues = [...this.status.helloIssues, 'the robot is not in lockstep mode (start it with CRUCIBLE_MODE=lockstep)']
      else if (this.lockstep && !this.lockstepStarted) this.beginLockstep()
      this.onStatus()
    } else if (type === MSG_STATS && body.byteLength >= 16) {
      // the robot times each ToApp frame against the arrival of its answer; that round trip is how stale the answer is when applied
      const us = new DataView(body.buffer, body.byteOffset, body.byteLength).getFloat64(0, true)
      if (us > 0) {
        this.rtt = us / 1e6
        if (this.autoLead) this.lead = Math.min(MAX_LEAD_S, this.rtt)
      }
    }
  }

  // ---- lockstep (Mode B)

  private beginLockstep(): void {
    this.lockstepStarted = true
    this.sendFromApp(0n, 12) // the state the robot starts from; steps are numbered from 1
    this.sendSeed() // after it: the robot resets its odometry against these gyro and wheel readings, not the ones of an earlier sim
    this.stepSeq = 0n
    this.paceWall = 0
    this.sendStep()
  }

  private sendFromApp(seq: bigint, battery: number): void {
    const dt = this.engine.drivetrain
    // lockstep: no real time passes between exchanges, so the latency fault does not apply
    this.emitFromApp({ seq, simTime: this.engine.time, batteryVolts: battery, motors: this.engine.predictMotorStates(0), cancoders: dt?.cancoderStates() ?? [], pigeons: dt ? [dt.pigeonState()] : [] }, false)
  }

  /** Sends the state to the robot: with the battery model and the faults applied, and (real-time mode) delayed by the latency fault. */
  private emitFromApp(frame: FromApp, delayable: boolean): void {
    const amps = this.engine.batteryAmps()
    const volts = this.battery.enabled ? batteryVoltage(this.battery, amps) : frame.batteryVolts
    const out = applyFaults({ ...frame, batteryVolts: volts }, this.faults, this.noise)
    this.batteryReading = { volts: out.batteryVolts, amps }
    this.sendVision()
    const bytes = encodeFromApp(out)
    if (delayable && this.faults.latencyMs > 0) setTimeout(() => this.ws.send(MSG_FROM_APP, bytes), this.faults.latencyMs)
    else this.ws.send(MSG_FROM_APP, bytes)
  }

  /** One vision message per 50 ms of simulated time: { t, tags: [{ id, distance, bearingDeg, elevationDeg, viewAngleDeg }], pose: { x, y, yaw, tags, stdXY, stdYawDeg } | null }. */
  private sendVision(): void {
    if (!this.vision.enabled) {
      if (this.visionReading.truth) this.visionReading = { tags: [], pose: null, truth: null }
      // camera off: the robot is told its exact pose (a perfect localisation). Its odometry follows the wheels, which keep turning when the robot
      // is held by a wall or another robot, so without this the robot code's pose runs away from the physics and its aim goes with it.
      const te = this.engine.time
      if (this.visionAt >= 0 && te >= this.visionAt && te - this.visionAt < 0.05) return
      this.visionAt = te
      const exact = this.engine.robotGroundPose()
      this.ws.send(MSG_VISION, new TextEncoder().encode(JSON.stringify({ t: te, tags: [], pose: { x: exact.x, y: exact.y, yaw: exact.yaw, tags: 0, stdXY: 0.01, stdYawDeg: 0.5 } })))
      return
    }
    const t = this.engine.time
    if (this.visionAt >= 0 && t >= this.visionAt && t - this.visionAt < 0.05) return
    this.visionAt = t
    const truth = this.engine.robotGroundPose()
    const tags = detectTags(truth, DEFAULT_CAMERA)
    const pose = estimatePose(truth, tags, this.noise, this.vision.noise)
    this.visionReading = { tags, pose, truth }
    this.ws.send(MSG_VISION, new TextEncoder().encode(JSON.stringify({ t, tags, pose })))
  }

  private sendStep(): void {
    if (!this.lockstep || !this.ws.connected) return
    if (this._paused) { this.stepPending = true; return }
    while (this.timeline.length > 0 && this.timeline[0].t <= this.engine.time + 1e-9) this.timeline.shift()!.fn()
    this.updateFms()
    if (this._paused) { this.stepPending = true; return } // a timed action may have paused the run
    this.stepPending = false
    this.ws.send(MSG_STEP, encodeStep(++this.stepSeq, this.lockstep.dt))
  }

  private resumeLockstep(): void { if (this.lockstep && this.lockstepStarted && this.stepPending) { this.paceWall = 0; this.sendStep() } }

  /** One exchange: apply the robot's voltages, step the physics for dt, answer with the new state, then pace and send the next Step. */
  private onToAppLockstep(bytes: Uint8Array): void {
    const f: ToApp | null = decodeToApp(bytes)
    if (!f || !this.lockstep) return
    const s = this.status
    s.frames++; s.lastSeq = f.seq; s.robotTime = f.simTime; s.robotEnabled = (f.flags & 1) !== 0
    for (const m of f.motors) {
      this.engine.setMotorVolts(m.id, m.appliedVolts)
      this.lastMotorVolts.set(m.id, m.appliedVolts)
      const reset = (m.flags & MOTOR_FLAG_RESET) !== 0
      if (reset && !this.resetSeen.has(m.id)) this.engine.resetMechanism(m.id)
      if (reset) this.resetSeen.add(m.id); else this.resetSeen.delete(m.id)
    }
    const n = Math.max(1, Math.round(this.lockstep.dt / this.engine.dt))
    for (let i = 0; i < n; i++) this.engine.step()
    this.lockstepSteps++
    this.sendFromApp(f.seq, f.batteryVolts)
    if (this.seedAfterNextState) { this.seedAfterNextState = false; this.sendSeed() }
    if (s.frames % 200 === 0) this.onStatus()
    // pacing: hold the sim clock to speed x wall clock (unlimited when 0)
    const speed = this.lockstep.speed ?? 0
    if (speed > 0) {
      const now = performance.now()
      if (this.paceWall === 0) { this.paceWall = now; this.paceSim = this.engine.time }
      const due = this.paceWall + ((this.engine.time - this.paceSim) / speed) * 1000
      if (due - now > 1) { setTimeout(() => this.sendStep(), due - now); return }
    }
    this.sendStep()
  }

  private onToApp(bytes: Uint8Array): void {
    const f = decodeToApp(bytes)
    const dt = this.engine.drivetrain
    if (!f) return
    const s = this.status
    s.frames++
    s.lastSeq = f.seq
    s.robotTime = f.simTime
    s.robotEnabled = (f.flags & 1) !== 0

    for (const m of f.motors) {
      this.engine.setMotorVolts(m.id, m.appliedVolts)
      this.lastMotorVolts.set(m.id, m.appliedVolts)
      // the robot code re-zeroed a mechanism: act once, on the rising edge of the flag
      const reset = (m.flags & MOTOR_FLAG_RESET) !== 0
      if (reset && !this.resetSeen.has(m.id)) this.engine.resetMechanism(m.id)
      if (reset) this.resetSeen.add(m.id); else this.resetSeen.delete(m.id)
    }

    if (this.lastRobotTime !== null && !this.paused) {
      let elapsed = f.simTime - this.lastRobotTime
      if (elapsed > MAX_CATCH_UP_S) { elapsed = MAX_CATCH_UP_S; s.skipped++ }
      if (elapsed > 0) {
        this.owed += elapsed / this.engine.dt
        const n = Math.floor(this.owed + 1e-9)
        this.owed -= n
        for (let i = 0; i < n; i++) this.engine.step()
      }
    }
    this.lastRobotTime = f.simTime

    this.emitFromApp({
      seq: f.seq,
      simTime: this.engine.time,
      batteryVolts: f.batteryVolts,
      motors: this.engine.predictMotorStates(this.lead),
      cancoders: dt?.cancoderStates() ?? [],
      pigeons: dt ? [dt.pigeonState()] : [],
    }, true)
    this.updateFms()
    if (this.seedAtFrame !== null && s.frames >= this.seedAtFrame) { this.seedAtFrame = null; this.sendSeed() }
    if (s.frames % 20 === 0) this.onStatus()
  }
}
