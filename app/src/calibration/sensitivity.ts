// Sensitivity report: how much does each tunable value matter? Each one is moved 10% down and 10% up (inside its range) while the others stay, and three
// quick probes are played with the physics the sim uses: the drivetrain's speed a quarter of a second after a full-power start (grip-limited: tire friction
// matters, mass cancels out), after a gentle 3 V start (motor-limited: mass matters, grip does not), and how far a fixed shot flies.
// The answer is a percent change per probe, so "mass barely matters, efficiency matters a lot" is a number, not a feeling.
// A value that no probe touches (bumper friction) is reported as having no effect on them rather than as unimportant.
import { applyTune, defaultTune, TUNE_DEFS, type TuneDef, type TuneParams } from '../engine/tuning'
import { OFFSEASON } from '../robots/offseason'
import { Engine } from '../engine/engine'
import { simulateAcceleration, floorEngineConfig } from './drive'
import { defaultShotModel, predictRange } from './shots'

export interface Probes { /** speed 0.25 s after a start at 12 V (grip-limited), m/s */ speed: number; /** the same at 3 V (motor-limited: mass matters, grip does not), m/s */ gentle: number; /** range of the fixed shot, m (null when it never comes down) */ range: number | null }
export interface SensRow {
  key: keyof TuneParams
  label: string
  unit: string
  /** the values tried, and the one in use */
  low: number
  value: number
  high: number
  /** percent change of each probe going from the low value to the high one (null: not measurable) */
  speedPct: number | null
  /** the same for the low-voltage start */
  gentlePct: number | null
  rangePct: number | null
  /** the larger of the two in size, for ordering */
  strength: number
}
export interface SensReport { base: Probes; rows: SensRow[]; rel: number }

export const PROBE_TIME = 0.25 // seconds after the start
export const GENTLE_VOLTS = 3
export const NO_EFFECT = 0.05 // percent: below this a probe did not move

/** The value moved by a fraction, kept inside the definition's range. */
export function moved(def: Pick<TuneDef, 'min' | 'max'>, value: number, frac: number): number { return Math.min(def.max, Math.max(def.min, value * (1 + frac))) }

/** Percent change from `a` to `b` relative to the base; null when the base is zero or a value is missing. */
export function pctChange(a: number | null, b: number | null, base: number | null): number | null {
  if (a === null || b === null || base === null || !Number.isFinite(base) || Math.abs(base) < 1e-12) return null
  return ((b - a) / Math.abs(base)) * 100
}

export function strength(...v: (number | null)[]): number { return Math.max(...v.map((x) => Math.abs(x ?? 0))) }

export function rowFrom(def: TuneDef, low: number, value: number, high: number, pl: Probes, pb: Probes, ph: Probes): SensRow {
  const speedPct = pctChange(pl.speed, ph.speed, pb.speed), gentlePct = pctChange(pl.gentle, ph.gentle, pb.gentle), rangePct = pctChange(pl.range, ph.range, pb.range)
  return { key: def.key, label: def.label, unit: def.unit, low, value, high, speedPct, gentlePct, rangePct, strength: strength(speedPct, gentlePct, rangePct) }
}

/** Plays both probes with the given tuned values. */
export async function probes(p: Required<TuneParams>): Promise<Probes> {
  const spec = { ...OFFSEASON.drivetrain, mu: p.mu, mass: p.mass }
  const e = await Engine.create(floorEngineConfig(spec))
  let speed: number, gentle: number
  try { speed = simulateAcceleration(e, spec, [PROBE_TIME], 12)[0]; gentle = simulateAcceleration(e, spec, [PROBE_TIME], GENTLE_VOLTS)[0] } finally { e.dispose() }
  const shot = { ...defaultShotModel(), efficiency: p.efficiency, backspin: p.backspin }
  const range = await predictRange(shot, { flywheelRps: 55, hoodDeg: 40, height: 0, exitHeight: null })
  return { speed, gentle, range }
}

export async function sensitivity(current: TuneParams = {}, rel = 0.1): Promise<SensReport> {
  const defs = defaultTune({ drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact })
  const base = applyTune({ drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact }, current)
  const now = defaultTune(base)
  void defs
  const baseProbes = await probes(now)
  const rows: SensRow[] = []
  for (const def of TUNE_DEFS) {
    const v = now[def.key]
    const low = moved(def, v, -rel), high = moved(def, v, rel)
    const pl = await probes({ ...now, [def.key]: low }), ph = await probes({ ...now, [def.key]: high })
    rows.push(rowFrom(def, low, v, high, pl, baseProbes, ph))
  }
  rows.sort((a, b) => b.strength - a.strength)
  return { base: baseProbes, rows, rel }
}

/** One line of plain words for a row. */
export function describe(r: SensRow): string {
  if (r.strength < NO_EFFECT) return 'no effect on these probes'
  const bits: string[] = []
  const f = (v: number | null, what: string): void => { if (v !== null && Math.abs(v) >= NO_EFFECT) bits.push(`${what} ${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`) }
  f(r.speedPct, 'full-power launch'); f(r.gentlePct, 'gentle launch'); f(r.rangePct, 'shot range')
  return bits.join(', ')
}
