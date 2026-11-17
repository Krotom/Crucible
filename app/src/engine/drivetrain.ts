// Swerve drivetrain physics: a per-module force model. Each module has a drive wheel and an azimuth (steer) joint driven
// by DC motor models from the voltages the robot's Talons apply; the tire force at each contact patch is a regularized
// Coulomb friction (capped at mu * normal load, friction circle between the longitudinal and lateral directions); the
// summed forces and torque act on the chassis body that Rapier integrates (so walls, balls and other bodies push back).
//
// Wheel and azimuth speeds are solved implicitly in the contact stiffness and the back-EMF so that a 1 ms step is stable
// with stiff tires. Voltage sign convention (as in CTRE's own swerve sim): positive drive volts drive the module
// forward and positive steer volts turn it counterclockwise, whatever the motor inversion is on the robot.
import type { CancoderState, MotorState, PigeonState } from './bridge/frames'
import type { MotorModel } from './motors'

const G = 9.81
const TWO_PI = 2 * Math.PI

export { KRAKEN_X60 } from './motors'

export interface ModuleSpec {
  /** Position in the robot frame, meters (+X forward, +Y left). */
  x: number
  y: number
  driveId: number
  steerId: number
  encoderId: number
}

export interface DrivetrainSpec {
  /** Total robot mass, kg. */
  mass: number
  wheelRadius: number
  driveRatio: number
  steerRatio: number
  /** Drive rotor rotations caused by one azimuth rotation (CTRE coupling ratio). */
  couplingRatio: number
  driveMotor: MotorModel
  steerMotor: MotorModel
  /** Inertia of the drive wheel assembly, and of the steered module, kg*m^2. */
  driveInertia: number
  steerInertia: number
  /** Friction modeled as a voltage deadband, like the CTRE constants. */
  driveFrictionVolts: number
  steerFrictionVolts: number
  driveCurrentLimit: number
  steerCurrentLimit: number
  /** Tire-floor friction coefficient. */
  mu: number
  /** Slip speed at which the tire force reaches mu * N, m/s (smaller is stiffer). */
  slipSpeed: number
  pigeonId: number
  modules: ModuleSpec[]
}

interface ModuleState {
  /** wheel angle (rad) and speed (rad/s), azimuth (rad) and speed (rad/s) */
  wheelAngle: number
  wheelSpeed: number
  azimuth: number
  azimuthSpeed: number
  prevDriveRotorRps: number
  prevSteerRotorRps: number
  driveAccel: number
  steerAccel: number
}

export interface ChassisState {
  x: number
  y: number
  /** wrapped yaw (rad) */
  yaw: number
  vx: number
  vy: number
  omega: number
}

export interface ChassisLoad { fx: number; fy: number; torque: number }

/** Friction as a voltage deadband: stuck below the threshold, subtracted in the direction of motion above it. */
function frictionVoltage(v: number, speed: number, vf: number): number {
  if (Math.abs(speed) > 1e-3) return v - Math.sign(speed) * vf
  return Math.abs(v) <= vf ? 0 : v - Math.sign(v) * vf
}

export class Drivetrain {
  readonly states: ModuleState[]
  private volts = new Map<number, number>()
  private unwrappedYaw = 0
  private lastYaw: number | null = null
  private lastOmega = 0

  constructor(readonly spec: DrivetrainSpec) {
    this.states = spec.modules.map(() => ({
      wheelAngle: 0, wheelSpeed: 0, azimuth: 0, azimuthSpeed: 0, prevDriveRotorRps: 0, prevSteerRotorRps: 0, driveAccel: 0, steerAccel: 0,
    }))
  }

  /** Sets the applied voltage of one motor (by CAN id); unknown ids are ignored. */
  setVolts(id: number, volts: number): void { this.volts.set(id, volts) }

  voltsOf(id: number): number { return this.volts.get(id) ?? 0 }

  /** Test and reset helper: put a module at an azimuth with the wheel at rest. */
  setAzimuth(index: number, rad: number): void { this.states[index].azimuth = rad; this.states[index].azimuthSpeed = 0 }

  /** Plain-data copy of the dynamic state, for snapshots. Applied voltages are inputs and are not part of it. */
  save(): unknown {
    return { states: this.states.map((s) => ({ ...s })), unwrappedYaw: this.unwrappedYaw, lastYaw: this.lastYaw, lastOmega: this.lastOmega }
  }

  load(data: unknown): void {
    const d = data as { states: ModuleState[]; unwrappedYaw: number; lastYaw: number | null; lastOmega: number }
    d.states.forEach((s, i) => Object.assign(this.states[i], s))
    this.unwrappedYaw = d.unwrappedYaw; this.lastYaw = d.lastYaw; this.lastOmega = d.lastOmega
  }

  /** Feeds every dynamic number into a state hash. */
  hashInto(add: (x: number) => void): void {
    for (const s of this.states) { add(s.wheelAngle); add(s.wheelSpeed); add(s.azimuth); add(s.azimuthSpeed) }
    add(this.unwrappedYaw)
  }

  reset(): void {
    for (const s of this.states) { s.wheelAngle = 0; s.wheelSpeed = 0; s.azimuth = 0; s.azimuthSpeed = 0; s.prevDriveRotorRps = 0; s.prevSteerRotorRps = 0; s.driveAccel = 0; s.steerAccel = 0 }
    this.unwrappedYaw = 0; this.lastYaw = null; this.lastOmega = 0
  }

  /** Advances the module states by dt and returns the force and torque the tires exert on the chassis (world frame). */
  step(dt: number, ch: ChassisState): ChassisLoad {
    const sp = this.spec
    const cy = Math.cos(ch.yaw)
    const sy = Math.sin(ch.yaw)
    const normal = (sp.mass * G) / sp.modules.length
    const fMax = sp.mu * normal
    const k = fMax / sp.slipSpeed
    const dm = sp.driveMotor
    const sm = sp.steerMotor
    let fx = 0
    let fy = 0
    let torque = 0

    sp.modules.forEach((mod, i) => {
      const s = this.states[i]
      const rx = cy * mod.x - sy * mod.y
      const ry = sy * mod.x + cy * mod.y
      const vix = ch.vx - ch.omega * ry
      const viy = ch.vy + ch.omega * rx
      const phi = ch.yaw + s.azimuth
      const dx = Math.cos(phi)
      const dy = Math.sin(phi)
      const vLong = vix * dx + viy * dy
      const vLat = -vix * dy + viy * dx

      // ---- steer joint: DC motor through the gearbox, back-EMF solved implicitly
      {
        const vEff = frictionVoltage(this.voltsOf(mod.steerId), s.azimuthSpeed, sp.steerFrictionVolts)
        const gk = sp.steerRatio * sm.kt / sm.resistance
        const b = gk * sp.steerRatio * sm.ke
        const j = sp.steerInertia / dt
        let w = (j * s.azimuthSpeed + gk * vEff) / (j + b)
        const tauMax = sp.steerRatio * sm.kt * sp.steerCurrentLimit
        const tau = j * (w - s.azimuthSpeed)
        if (Math.abs(tau) > tauMax) w = s.azimuthSpeed + (Math.sign(tau) * tauMax * dt) / sp.steerInertia
        s.azimuthSpeed = w
        s.azimuth += w * dt
      }

      // ---- drive wheel: motor torque plus implicit contact stiffness
      const vEff = frictionVoltage(this.voltsOf(mod.driveId), s.wheelSpeed, sp.driveFrictionVolts)
      const gk = sp.driveRatio * dm.kt / dm.resistance
      const b = gk * sp.driveRatio * dm.ke
      const tauMax = sp.driveRatio * dm.kt * sp.driveCurrentLimit
      const j = sp.driveInertia / dt
      const r = sp.wheelRadius
      let w = (j * s.wheelSpeed + gk * vEff + r * k * vLong) / (j + b + r * r * k)
      let motorTorque = gk * vEff - b * w
      if (Math.abs(motorTorque) > tauMax) {
        motorTorque = Math.sign(motorTorque) * tauMax
        w = (j * s.wheelSpeed + motorTorque + r * k * vLong) / (j + r * r * k)
      }
      let fLong = k * (w * r - vLong)
      let fLat = -k * vLat
      const mag = Math.hypot(fLong, fLat)
      if (mag > fMax) {
        const scale = fMax / mag
        fLong *= scale
        fLat *= scale
        // sliding: the tire force is fixed at its limit, so solve the wheel speed with the back-EMF at the new speed
        w = (j * s.wheelSpeed + gk * vEff - r * fLong) / (j + b)
        motorTorque = gk * vEff - b * w
        if (Math.abs(motorTorque) > tauMax) {
          motorTorque = Math.sign(motorTorque) * tauMax
          w = s.wheelSpeed + ((motorTorque - r * fLong) * dt) / sp.driveInertia
        }
      }
      s.wheelSpeed = w
      s.wheelAngle += w * dt

      const wx = fLong * dx - fLat * dy
      const wy = fLong * dy + fLat * dx
      fx += wx
      fy += wy
      torque += rx * wy - ry * wx

      // rotor-side accelerations for the Talon sims (finite difference of rotor speed)
      const driveRps = this.driveRotorRps(s)
      const steerRps = (sp.steerRatio * s.azimuthSpeed) / TWO_PI
      s.driveAccel = (driveRps - s.prevDriveRotorRps) / dt
      s.steerAccel = (steerRps - s.prevSteerRotorRps) / dt
      s.prevDriveRotorRps = driveRps
      s.prevSteerRotorRps = steerRps
    })

    // continuous yaw for the Pigeon
    if (this.lastYaw !== null) {
      let d = ch.yaw - this.lastYaw
      while (d > Math.PI) d -= TWO_PI
      while (d < -Math.PI) d += TWO_PI
      this.unwrappedYaw += d
    } else this.unwrappedYaw = ch.yaw
    this.lastYaw = ch.yaw
    this.lastOmega = ch.omega
    return { fx, fy, torque }
  }

  private driveRotorRps(s: ModuleState): number {
    return (this.spec.driveRatio * s.wheelSpeed + this.spec.couplingRatio * s.azimuthSpeed) / TWO_PI
  }

  // ---- what the robot's Talons, CANcoders and Pigeon see

  motorStates(): MotorState[] {
    const sp = this.spec
    const out: MotorState[] = []
    sp.modules.forEach((mod, i) => {
      const s = this.states[i]
      out.push({
        id: mod.driveId,
        rotorPositionRot: (sp.driveRatio * s.wheelAngle + sp.couplingRatio * s.azimuth) / TWO_PI,
        rotorVelocityRps: this.driveRotorRps(s),
        rotorAccelRps2: s.driveAccel,
      })
      out.push({
        id: mod.steerId,
        rotorPositionRot: (sp.steerRatio * s.azimuth) / TWO_PI,
        rotorVelocityRps: (sp.steerRatio * s.azimuthSpeed) / TWO_PI,
        rotorAccelRps2: s.steerAccel,
      })
    })
    return out
  }

  cancoderStates(): CancoderState[] {
    return this.spec.modules.map((mod, i) => {
      const pos = this.states[i].azimuth / TWO_PI
      return { id: mod.encoderId, positionRot: pos, velocityRps: this.states[i].azimuthSpeed / TWO_PI, absolutePositionRot: pos - Math.floor(pos) }
    })
  }

  pigeonState(): PigeonState {
    return {
      id: this.spec.pigeonId,
      yawDeg: (this.unwrappedYaw * 180) / Math.PI, pitchDeg: 0, rollDeg: 0,
      yawRateDps: (this.lastOmega * 180) / Math.PI, pitchRateDps: 0, rollRateDps: 0,
      accelXg: 0, accelYg: 0, accelZg: 1,
    }
  }
}
