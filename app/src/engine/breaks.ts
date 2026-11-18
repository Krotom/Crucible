// Breakpoints on sim events: pause the run when a shot is launched, a piece picked up, points scored, a foul called, a hard impact, a phase change
// or a given sim time is reached. Pure matching, used by the worker after every step.
import type { UiEvent } from './protocol'

export interface BreakSpec {
  launch: boolean
  capture: boolean
  score: boolean
  foul: boolean
  /** pause on an impact at least this hard (m/s), or null */
  impact: number | null
  phase: boolean
  /** pause when the sim clock reaches this many seconds, or null */
  time: number | null
}

export const NO_BREAKS: BreakSpec = { launch: false, capture: false, score: false, foul: false, impact: null, phase: false, time: null }

export function cleanBreaks(b: Partial<BreakSpec> | undefined): BreakSpec {
  const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)
  return {
    launch: b?.launch === true, capture: b?.capture === true, score: b?.score === true, foul: b?.foul === true, phase: b?.phase === true,
    impact: num(b?.impact, 0.1, 50), time: num(b?.time, 0, 100000),
  }
}

export const anyBreak = (b: BreakSpec): boolean => b.launch || b.capture || b.score || b.foul || b.phase || b.impact !== null || b.time !== null

/** Why the run should pause for these new events at this sim time, or null. `timeDone` says the time breakpoint already fired for the current stretch. */
export function matchBreak(events: UiEvent[], b: BreakSpec, time: number, timeDone: boolean): { reason: string; timeFired: boolean } | null {
  for (const e of events) {
    if (e.kind === 'launch' && b.launch) return { reason: `shot launched at ${e.speed.toFixed(1)} m/s`, timeFired: timeDone }
    if (e.kind === 'capture' && b.capture) return { reason: 'FUEL picked up', timeFired: timeDone }
    if (e.kind === 'score') {
      const foul = /^G\d{3}/.test(e.reason)
      if (foul && b.foul) return { reason: `foul: ${e.reason}`, timeFired: timeDone }
      if (!foul && b.score) return { reason: `${e.alliance} scored +${e.points}: ${e.reason}`, timeFired: timeDone }
    }
    if (e.kind === 'impact' && b.impact !== null && e.speed >= b.impact) return { reason: `impact ${e.speed.toFixed(1)} m/s (${e.against === 'robot' ? 'robot' : 'wall'})`, timeFired: timeDone }
    if (e.kind === 'phase' && b.phase) return { reason: `phase ${e.to}`, timeFired: timeDone }
  }
  if (b.time !== null && !timeDone && time >= b.time) return { reason: `sim time ${b.time} s reached`, timeFired: true }
  return null
}
