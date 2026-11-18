// Things that go wrong on a real robot, applied to what the app sends back to the robot code: a CAN device that stops answering, a brownout,
// noisy sensors, a slow link; and the battery that sags under load. Pure functions on the FromApp frame, so they are tested without a robot.
import type { FromApp } from './frames'

export interface Faults {
  /** battery voltage forced to this value (a brownout), or null */
  brownoutVolts: number | null
  /** extra delay before the robot sees the state, ms (real-time mode only: lockstep time does not pass between exchanges) */
  latencyMs: number
  /** sensor noise level: 0 none, 1 mild, up to 5 very noisy */
  noise: number
  /** CAN ids that no longer answer: the robot gets no state for them */
  dropIds: number[]
}

export const NO_FAULTS: Faults = { brownoutVolts: null, latencyMs: 0, noise: 0, dropIds: [] }

export interface BatteryModel {
  enabled: boolean
  /** open-circuit voltage, V */
  openVolts: number
  /** internal resistance including the wiring, ohm */
  resistance: number
}

export const DEFAULT_BATTERY: BatteryModel = { enabled: false, openVolts: 12.6, resistance: 0.018 }

/** Battery voltage under a load of `amps` (never below 4 V: the robot is long browned out by then). */
export function batteryVoltage(b: BatteryModel, amps: number): number {
  return Math.max(4, b.openVolts - b.resistance * Math.max(0, amps))
}

export function cleanFaults(f: Partial<Faults> | undefined): Faults {
  const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  return {
    brownoutVolts: f?.brownoutVolts === null || f?.brownoutVolts === undefined ? null : num(f.brownoutVolts, 0, 14, 6.8),
    latencyMs: num(f?.latencyMs, 0, 500, 0),
    noise: num(f?.noise, 0, 5, 0),
    dropIds: Array.isArray(f?.dropIds) ? [...new Set(f!.dropIds.filter((x) => Number.isInteger(x) && x >= 0 && x < 100))] : [],
  }
}

export function cleanBattery(b: Partial<BatteryModel> | undefined): BatteryModel {
  const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  return { enabled: b?.enabled === true, openVolts: num(b?.openVolts, 8, 14, DEFAULT_BATTERY.openVolts), resistance: num(b?.resistance, 0.005, 0.1, DEFAULT_BATTERY.resistance) }
}

/** A small seeded random source (mulberry32) with a normal distribution, so the same faults give the same noise run after run. */
export class Noise {
  private s: number
  constructor(seed = 1) { this.s = seed >>> 0 }
  uniform(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  normal(): number {
    const u = Math.max(1e-12, this.uniform()), v = this.uniform()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** The frame the robot gets: devices that dropped out removed, sensor values noisy, the battery browned out. The input frame is not modified. */
export function applyFaults(frame: FromApp, f: Faults, noise: Noise): FromApp {
  if (f.brownoutVolts === null && f.noise === 0 && f.dropIds.length === 0) return frame
  const drop = new Set(f.dropIds)
  const n = f.noise
  const g = (std: number): number => (n === 0 ? 0 : noise.normal() * std * n)
  return {
    ...frame,
    batteryVolts: f.brownoutVolts ?? frame.batteryVolts,
    motors: frame.motors.filter((m) => !drop.has(m.id)).map((m) => ({ ...m, rotorPositionRot: m.rotorPositionRot + g(0.002), rotorVelocityRps: m.rotorVelocityRps + g(0.05) })),
    cancoders: frame.cancoders.filter((c) => !drop.has(c.id)).map((c) => ({ ...c, positionRot: c.positionRot + g(0.001), absolutePositionRot: c.absolutePositionRot + g(0.001), velocityRps: c.velocityRps + g(0.02) })),
    pigeons: frame.pigeons.filter((p) => !drop.has(p.id)).map((p) => ({ ...p, yawDeg: p.yawDeg + g(0.2), pitchDeg: p.pitchDeg + g(0.1), rollDeg: p.rollDeg + g(0.1), yawRateDps: p.yawRateDps + g(0.5) })),
  }
}
