// The physical values worth adjusting while looking at the sim: what they are, their sensible ranges, floor presets, and how they are laid over a
// robot definition. Pure, so the page, the worker and the tests share it.
import type { DrivetrainSpec } from './drivetrain'
import type { BallHandlingSpec, ChassisContact } from './types'

export interface TuneParams {
  /** tire friction coefficient on the carpet */
  mu?: number
  /** robot mass with bumpers and battery, kg */
  mass?: number
  /** FUEL speed over flywheel surface speed */
  efficiency?: number
  /** spin of a shot, r * w / v */
  backspin?: number
  /** bumper friction */
  bumperFriction?: number
}

export interface TuneDef {
  key: keyof TuneParams
  label: string
  unit: string
  min: number
  max: number
  step: number
  /** true: takes effect at once in a running sim; false: from the next Reset */
  live: boolean
  hint: string
}

export const TUNE_DEFS: TuneDef[] = [
  { key: 'mu', label: 'Tire friction', unit: '', min: 0.4, max: 2.0, step: 0.01, live: true, hint: 'How much grip the swerve wheels have on the carpet: limits acceleration and pushing force' },
  { key: 'mass', label: 'Robot mass', unit: 'kg', min: 30, max: 70, step: 0.5, live: false, hint: 'Robot with bumpers and battery. Takes effect at the next Reset' },
  { key: 'efficiency', label: 'Shot efficiency', unit: '', min: 0.3, max: 1.2, step: 0.005, live: true, hint: 'FUEL exit speed over flywheel surface speed: the compression and slip of the shot' },
  { key: 'backspin', label: 'Backspin', unit: '', min: 0, max: 0.6, step: 0.005, live: true, hint: 'Spin of a shot (r·ω/v): more lifts the ball and carries it further' },
  { key: 'bumperFriction', label: 'Bumper friction', unit: '', min: 0.1, max: 1.0, step: 0.01, live: false, hint: 'How the bumpers grip walls and other robots. Takes effect at the next Reset' },
]

export const FLOOR_PRESETS: { id: string; label: string; mu: number }[] = [
  { id: 'slick', label: 'Slick floor', mu: 0.6 },
  { id: 'worn', label: 'Worn carpet', mu: 0.9 },
  { id: 'carpet', label: 'Carpet', mu: 1.2 },
  { id: 'sticky', label: 'New, sticky carpet', mu: 1.45 },
]

const DEF = new Map(TUNE_DEFS.map((d) => [d.key, d]))

/** Keeps only known keys with finite numbers, clamped to their range: what comes from saved settings or typed text can never break the sim. */
export function cleanTune(p: unknown): TuneParams {
  const out: TuneParams = {}
  if (!p || typeof p !== 'object') return out
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    const d = DEF.get(k as keyof TuneParams)
    if (d && typeof v === 'number' && Number.isFinite(v)) out[d.key] = Math.min(d.max, Math.max(d.min, v))
  }
  return out
}

export interface TunableBase { drivetrain: DrivetrainSpec; balls?: BallHandlingSpec; contact: ChassisContact }

/** The definition's own values for the tunable parameters. */
export function defaultTune(base: TunableBase): Required<TuneParams> {
  return {
    mu: base.drivetrain.mu, mass: base.drivetrain.mass, efficiency: base.balls?.shooter.efficiency ?? 0.7, backspin: base.balls?.shooter.backspin ?? 0.2,
    bumperFriction: base.contact.friction ?? 0.45,
  }
}

/** The definition with the tuned values laid over it (copies the parts it changes: the definition itself is never modified). */
export function applyTune<T extends TunableBase>(base: T, p: TuneParams): T {
  const t = cleanTune(p)
  return {
    ...base,
    drivetrain: { ...base.drivetrain, ...(t.mu !== undefined ? { mu: t.mu } : {}), ...(t.mass !== undefined ? { mass: t.mass } : {}) },
    balls: base.balls ? { ...base.balls, shooter: { ...base.balls.shooter, ...(t.efficiency !== undefined ? { efficiency: t.efficiency } : {}), ...(t.backspin !== undefined ? { backspin: t.backspin } : {}) } } : undefined,
    contact: { ...base.contact, ...(t.bumperFriction !== undefined ? { friction: t.bumperFriction } : {}) },
  }
}

/** Which parameters differ from the definition. */
export function changedKeys(p: TuneParams, def: Required<TuneParams>): (keyof TuneParams)[] {
  const t = cleanTune(p)
  return (Object.keys(t) as (keyof TuneParams)[]).filter((k) => Math.abs((t[k] as number) - def[k]) > 1e-9)
}
