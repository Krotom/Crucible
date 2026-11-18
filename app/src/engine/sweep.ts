// Seed sweep: the same scripted match played with many seeds, to see how much the result depends on the random start layout.
// Runs flat out inside a worker (nothing is drawn); every run is a fresh engine from the same setup the live sim uses.
import { Engine } from './engine'
import { buildSetup, type InitParams } from './setup'
import type { TuneParams } from './tuning'

export interface SweepRequest {
  game: 'test' | 'rebuilt'
  alliance: 'blue' | 'red'
  opponent: InitParams['opponent']
  start?: InitParams['start']
  tune?: TuneParams
  stepDt: number
  /** the seeds to play, one run each */
  seeds: number[]
  /** simulated seconds per run */
  duration: number
}

export interface SweepRun { seed: number; blue: number; red: number; fouls: number; wallMs: number }

export async function runSweep(req: SweepRequest, onRun: (r: SweepRun, index: number) => void, cancelled: () => boolean): Promise<SweepRun[]> {
  const out: SweepRun[] = []
  for (const seed of req.seeds) {
    if (cancelled()) break
    const setup = buildSetup({ mode: 'script', game: req.game, opponent: req.opponent, stepDt: req.stepDt, alliance: req.alliance, start: req.start, tune: req.tune })
    const e = await Engine.create({ ...setup.config, seed })
    try {
      let fouls = 0
      e.observeScores((s) => { if (/^G\d{3}/.test(s.reason)) fouls++ })
      const t0 = performance.now()
      const steps = Math.max(1, Math.ceil(req.duration / e.dt))
      for (let i = 0; i < steps; i++) e.step()
      const sc = e.scoreTotals
      const run = { seed, blue: sc.blue, red: sc.red, fouls, wallMs: performance.now() - t0 }
      out.push(run)
      onRun(run, out.length - 1)
    } finally { e.dispose() }
    await new Promise((r) => setTimeout(r, 0)) // let a cancel message in between runs
  }
  return out
}

export interface SweepStats { n: number; mean: number; sd: number; min: number; max: number; median: number }

export function stats(values: number[]): SweepStats | null {
  const n = values.length
  if (n === 0) return null
  const mean = values.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const s = [...values].sort((a, b) => a - b)
  return { n, mean, sd, min: s[0], max: s[n - 1], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2 }
}

/** Blue wins, red wins and ties over a set of runs. */
export function record(runs: SweepRun[]): { blue: number; red: number; tie: number } {
  return runs.reduce((a, r) => { if (r.blue > r.red) a.blue++; else if (r.red > r.blue) a.red++; else a.tie++; return a }, { blue: 0, red: 0, tie: 0 })
}
