// Mode A bridge session: the robot's clock drives the physics. Each ToApp frame from the robot carries the applied motor
// voltages and the robot's simulation time; the session steps the engine for the elapsed robot time with those voltages
// held, then answers with a FromApp frame (rotor, CANcoder and Pigeon states) carrying the same sequence number.
import type { Engine } from '../engine'
import { Nt4Raw } from './nt4raw'
import {
  decodeToApp, encodeDs, encodeFromApp, encodeJoystick, encodePoseSeed, type DsState, type JoystickState,
} from './frames'

const ROOT = '/SimBridge/main/'
const SEED_DELAY_FRAMES = 20
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
}

export class BridgeSession {
  private nt: Nt4Raw
  private lastRobotTime: number | null = null
  private owed = 0
  private ctrlCounter = 1n
  paused = false
  private ds: DsState = { counter: 0n, enabled: false, autonomous: false, test: false, estop: false, dsAttached: true, alliance: 1, station: 1, matchTime: 0 }
  private joystick: JoystickState = { counter: 0n, axes: [0, 0, 0, 0, 0, 0], buttons: 0n, pov: -1 }
  private poseSeedCounter = 0n
  /** frame count at which a pending pose seed is sent (null when none is pending) */
  private seedAtFrame: number | null = null
  status: BridgeStatus = { connected: false, frames: 0, lastSeq: 0n, robotTime: 0, skipped: 0, robotEnabled: false, helloDevices: null }

  constructor(private engine: Engine, host: string, port: number, private onStatus: () => void = () => {}) {
    this.nt = new Nt4Raw(host, port)
    this.nt.publishRaw(ROOT + 'FromApp/Frame')
    this.nt.publishRaw(ROOT + 'Control/DS')
    this.nt.publishRaw(ROOT + 'Control/Joystick/0')
    this.nt.publishRaw(ROOT + 'Control/PoseSeed')
    this.nt.subscribeRaw(ROOT + 'ToApp/Frame', (b) => this.onToApp(b))
    this.nt.subscribeString(ROOT + 'Hello', (s) => { this.status.helloDevices = s; this.onStatus() })
    this.nt.onConnection = (c) => {
      this.status.connected = c
      if (c) { this.lastRobotTime = null; this.owed = 0; this.sendDs(); this.sendJoystick(); this.seedPose() }
      this.onStatus()
    }
  }

  start(): void { this.nt.start() }
  stop(): void { this.nt.stop(); this.status.connected = false }

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
    this.nt.setRaw(ROOT + 'Control/PoseSeed', encodePoseSeed({ counter: ++this.poseSeedCounter, x: f.robot[0], y: f.robot[1], yawRad: yaw }))
  }

  private sendDs(): void { this.ds = { ...this.ds, counter: this.ctrlCounter++ }; this.nt.setRaw(ROOT + 'Control/DS', encodeDs(this.ds)) }

  private sendJoystick(): void {
    this.joystick = { ...this.joystick, counter: this.ctrlCounter++ }
    this.nt.setRaw(ROOT + 'Control/Joystick/0', encodeJoystick(this.joystick))
  }

  // ---- the exchange

  private onToApp(bytes: Uint8Array): void {
    const f = decodeToApp(bytes)
    const dt = this.engine.drivetrain
    if (!f || !dt) return
    const s = this.status
    s.frames++
    s.lastSeq = f.seq
    s.robotTime = f.simTime
    s.robotEnabled = (f.flags & 1) !== 0

    for (const m of f.motors) dt.setVolts(m.id, m.appliedVolts)

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

    this.nt.setRaw(ROOT + 'FromApp/Frame', encodeFromApp({
      seq: f.seq,
      simTime: this.engine.time,
      batteryVolts: f.batteryVolts,
      motors: dt.motorStates(),
      cancoders: dt.cancoderStates(),
      pigeons: [dt.pigeonState()],
    }))
    if (this.seedAtFrame !== null && s.frames >= this.seedAtFrame) { this.seedAtFrame = null; this.sendSeed() }
    if (s.frames % 20 === 0) this.onStatus()
  }
}
