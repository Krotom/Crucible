// Mode A bridge session: the robot's clock drives the physics. Each ToApp frame from the robot carries the applied motor
// voltages and the robot's simulation time; the session steps the engine for the elapsed robot time with those voltages
// held, then answers with a FromApp frame (rotor, CANcoder and Pigeon states) carrying the same sequence number.
// Frames and controls travel on the local WebSocket channel; NetworkTables is only listened to for the robot's own
// articulated component poses (what the 3D model draws).
import type { Engine } from '../engine'
import { checkAgainstHello, type RobotDefinition } from '../../robots/definition'
import { decodeStruct } from '../../renderer/src/lib/structs'
import { Nt4Raw } from './nt4raw'
import {
  decodeToApp, encodeDs, encodeFromApp, encodeJoystick, encodePoseSeed, type DsState, type JoystickState,
} from './frames'
import {
  DEFAULT_WS_PORT, MSG_DS, MSG_FROM_APP, MSG_HELLO, MSG_JOYSTICK, MSG_POSE_SEED, MSG_STATS, MSG_TO_APP, WsTransport,
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

export class BridgeSession {
  private ws: WsTransport
  private nt: Nt4Raw | null = null
  private lastRobotTime: number | null = null
  private owed = 0
  private ctrlCounter = 1n
  paused = false
  /** how far ahead of the physics clock the mechanism states are reported, seconds (follows the measured round trip) */
  lead = DEFAULT_LEAD_S
  /** follow the round trip the robot measures (turn off to set the lead by hand) */
  autoLead = true
  /** the robot's measured round trip of the exchange, seconds (0 until it reports) */
  rtt = 0
  private ds: DsState = { counter: 0n, enabled: false, autonomous: false, test: false, estop: false, dsAttached: true, alliance: 1, station: 1, matchTime: 0 }
  private joystick: JoystickState = { counter: 0n, axes: [0, 0, 0, 0, 0, 0], buttons: 0n, pov: -1 }
  private poseSeedCounter = 0n
  /** frame count at which a pending pose seed is sent (null when none is pending) */
  private seedAtFrame: number | null = null
  private resetSeen = new Set<number>()
  status: BridgeStatus = { connected: false, frames: 0, lastSeq: 0n, robotTime: 0, skipped: 0, robotEnabled: false, helloDevices: null, helloIssues: [], components: null }

  constructor(private engine: Engine, host: string, ports: BridgePorts = {}, private onStatus: () => void = () => {}, private def: RobotDefinition | null = null) {
    this.ws = new WsTransport(host, ports.ws ?? DEFAULT_WS_PORT)
    this.ws.onMessage = (type, body) => this.onMessage(type, body)
    this.ws.onConnection = (c) => {
      this.status.connected = c
      if (c) { this.lastRobotTime = null; this.owed = 0; this.sendDs(); this.sendJoystick(); this.seedPose() }
      this.onStatus()
    }
    if (ports.nt !== null) {
      this.nt = new Nt4Raw(host, ports.nt ?? 5810)
      this.nt.subscribeRaw(COMPONENTS_TOPIC, (b) => { this.status.components = decodeStruct('struct:Pose3d[]', b) })
    }
  }

  start(): void { this.ws.start(); this.nt?.start() }
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
  seedPose(): void { this.seedAtFrame = this.status.frames + SEED_DELAY_FRAMES }

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
    if (type === MSG_TO_APP) this.onToApp(body)
    else if (type === MSG_HELLO) {
      const text = new TextDecoder().decode(body)
      this.status.helloDevices = text
      if (this.def) this.status.helloIssues = checkAgainstHello(this.def, text)
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

    this.ws.send(MSG_FROM_APP, encodeFromApp({
      seq: f.seq,
      simTime: this.engine.time,
      batteryVolts: f.batteryVolts,
      motors: this.engine.predictMotorStates(this.lead),
      cancoders: dt?.cancoderStates() ?? [],
      pigeons: dt ? [dt.pigeonState()] : [],
    }))
    if (this.seedAtFrame !== null && s.frames >= this.seedAtFrame) { this.seedAtFrame = null; this.sendSeed() }
    if (s.frames % 20 === 0) this.onStatus()
  }
}
