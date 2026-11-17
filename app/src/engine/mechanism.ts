// A rotary mechanism driven by one Talon (possibly several motors on one shaft): DC motor through a gearbox into an
// inertia, integrated exactly for a voltage held over the step (the same discretization WPILib's DCMotorSim uses), with
// optional friction and hard stops. The Talon runs the control loop on the robot; this is only the physics behind it.
import type { MotorState } from './bridge/frames'
import { MOTORS, parallel, type MotorModel } from './motors'

const TWO_PI = 2 * Math.PI

export interface MechanismSpec {
  /** CAN id of the Talon (the lead motor when several share the load). */
  id: number
  name: string
  motor: string
  /** Number of motors on the shaft. */
  count: number
  /** Rotor rotations per mechanism rotation (the Talon's SensorToMechanismRatio). */
  gearRatio: number
  /** Moment of inertia about the mechanism axis, kg*m^2. */
  inertia: number
  /** Friction as a voltage deadband, V (0 = none, like the old DCMotorSim). */
  frictionVolts?: number
  /** Hard stops in mechanism rotations; the mechanism stops dead against them. */
  limits?: { min: number; max: number }
}

export class MechanismModel {
  /** mechanism angle (rad) and speed (rad/s) */
  angle = 0
  speed = 0
  private motor: MotorModel
  private prevRotorRps = 0
  private accel = 0

  constructor(readonly spec: MechanismSpec) {
    const base = MOTORS[spec.motor]
    if (!base) throw new Error(`Unknown motor "${spec.motor}" for mechanism ${spec.name}`)
    this.motor = parallel(base, spec.count)
  }

  reset(): void { this.angle = 0; this.speed = 0; this.prevRotorRps = 0; this.accel = 0 }

  step(dt: number, volts: number): void {
    const { gearRatio: g, inertia: j, frictionVolts: vf = 0, limits } = this.spec
    const m = this.motor
    let v = volts
    if (vf > 0) {
      if (Math.abs(this.speed) > 1e-3) v -= Math.sign(this.speed) * vf
      else v = Math.abs(v) <= vf ? 0 : v - Math.sign(v) * vf
    }
    // J dw/dt = (G kt / R) V - b w, with b = G^2 kt ke / R; exact for constant V
    const b = (g * g * m.kt * m.ke) / m.resistance
    const wInf = v / (m.ke * g)
    const k = Math.exp((-b * dt) / j)
    const w0 = this.speed
    this.angle += wInf * dt + (w0 - wInf) * (j / b) * (1 - k)
    this.speed = wInf + (w0 - wInf) * k
    if (limits) {
      const lo = limits.min * TWO_PI
      const hi = limits.max * TWO_PI
      if (this.angle > hi) { this.angle = hi; if (this.speed > 0) this.speed = 0 }
      else if (this.angle < lo) { this.angle = lo; if (this.speed < 0) this.speed = 0 }
    }
    const rps = (g * this.speed) / TWO_PI
    this.accel = (rps - this.prevRotorRps) / dt
    this.prevRotorRps = rps
  }

  /** Mechanism position in rotations and speed in rotations per second (what the robot code calls position and velocity). */
  get rotations(): number { return this.angle / TWO_PI }
  get rps(): number { return this.speed / TWO_PI }

  motorState(): MotorState {
    const g = this.spec.gearRatio
    return { id: this.spec.id, rotorPositionRot: (g * this.angle) / TWO_PI, rotorVelocityRps: (g * this.speed) / TWO_PI, rotorAccelRps2: this.accel }
  }

  save(): unknown { return { angle: this.angle, speed: this.speed, prevRotorRps: this.prevRotorRps, accel: this.accel } }

  load(d: unknown): void { Object.assign(this, d as object) }
}
