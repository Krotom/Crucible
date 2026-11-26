// What the live view's readout works out from the robot's Driver Station data: which HUB is active, and when that changes.
import { PHASES, hubActive } from '../../../games/rebuilt'
import type { Alliance } from '../../../engine/types'

export type RobotMode = 'disabled' | 'auto' | 'teleop' | 'test'

const AUTO_SECONDS = 20
const TELEOP_SECONDS = 140
/** seconds from the start of AUTO to the start of TELEOP in the game module's phases (AUTO plus the 3 s scoring delay) */
const TELEOP_STARTS = PHASES[0].duration + PHASES[1].duration

/** Seconds since the match started, from the Driver Station's match time (it counts down in each period), or null when it is not a match period. */
export function matchElapsed(mode: RobotMode, matchTime: number | null): number | null {
  if (matchTime === null || !Number.isFinite(matchTime) || matchTime < 0) return null
  if (mode === 'auto') return Math.min(AUTO_SECONDS, Math.max(0, AUTO_SECONDS - matchTime))
  if (mode === 'teleop') return TELEOP_STARTS + Math.min(TELEOP_SECONDS, Math.max(0, TELEOP_SECONDS - matchTime))
  return null
}

export interface HubStatus {
  phase: string
  blue: boolean
  red: boolean
  /** false until the field has sent the Game Data: in the SHIFTs the answer is a guess until then */
  known: boolean
  /** seconds until the phase changes, or null at the end of the match */
  untilChange: number | null
  /** the phase that follows, or null */
  next: string | null
}

/** Which HUBs are active (manual 6.4.1) at `elapsed` seconds, given the Game Data character: the alliance whose HUB is inactive first ('R' or 'B'). */
export function hubStatus(elapsed: number, gameData: string): HubStatus {
  let acc = 0
  let idx = PHASES.length - 1
  for (let i = 0; i < PHASES.length; i++) { acc += PHASES[i].duration; if (elapsed < acc) { idx = i; break } }
  const phase = PHASES[idx].name
  const firstInactive: Alliance | null = gameData === 'R' ? 'red' : gameData === 'B' ? 'blue' : null
  const known = firstInactive !== null || !/^shift/.test(phase)
  const last = idx === PHASES.length - 1
  return {
    phase,
    blue: hubActive('blue', phase, firstInactive),
    red: hubActive('red', phase, firstInactive),
    known,
    untilChange: last ? null : acc - elapsed,
    next: last ? null : PHASES[idx + 1].name,
  }
}

/** The topic that ends with `suffix`, preferring the AdvantageKit copy; topic names differ between robot projects, so the live view finds them by their tail. */
export function pickTopic(names: readonly string[], suffix: string): string | undefined {
  const hits = names.filter((n) => n.endsWith(suffix))
  return hits.find((n) => n.startsWith('/AdvantageKit/')) ?? hits[0]
}

/** 'M:SS' for a number of seconds (negative and missing values give dashes). */
export function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '-:--'
  const s = Math.ceil(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
