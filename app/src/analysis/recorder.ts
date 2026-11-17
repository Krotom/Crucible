// Collects what happened in a run (events, 10 Hz samples) and turns it into the numbers a team looks at: score over time, shots and accuracy,
// shot bursts and cycle times, distance driven, contacts. Works on any Engine, with or without a robot behind it.
import type { Engine } from '../engine/engine'
import type { GameEvent } from '../engine/types'

export interface Sample { t: number; x: number; y: number; yaw: number; speed: number; held: number; blue: number; red: number; z: number }
export interface Launch { t: number; speed: number; pieceId: number; x: number; y: number; scored: boolean; scoredAt: number | null }
export interface Burst { start: number; end: number; count: number; scored: number }

export interface RunReport {
  name: string
  game: string
  seed: number
  duration: number
  step: number
  final: { blue: number; red: number }
  /** [t, blue, red] at each change in score and at the end */
  scoreTimeline: [number, number, number][]
  captures: number[]
  launches: Launch[]
  shots: number
  scoredShots: number
  /** scored / shots (null when nothing was fired) */
  accuracy: number | null
  bursts: Burst[]
  /** seconds from the start of one shot burst to the start of the next: the time of a full cycle (pick up, drive, shoot) */
  cycleTimes: number[]
  meanCycle: number | null
  /** seconds from capturing a FUEL to launching one, first in first out */
  carryTimes: number[]
  distance: number
  maxSpeed: number
  maxZ: number
  hits: { count: number; hardest: number }
  enabledSeconds: number
  status: Record<string, string>
  samples: Sample[]
}

/** Launches closer together than this belong to the same burst. */
export const BURST_GAP = 1.0
/** A launched FUEL that reaches a HUB within this many seconds counts as that shot's result. */
const SCORE_WINDOW = 6

export class Recorder {
  private captures: number[] = []
  private launches: Launch[] = []
  private byPiece = new Map<number, Launch>()
  private samples: Sample[] = []
  private hits = { count: 0, hardest: 0 }
  private distance = 0
  private lastXY: [number, number] | null = null
  private enabledTime = 0
  private lastEnabledT = 0
  private lastScore = { blue: -1, red: -1 }
  private timeline: [number, number, number][] = []
  private detach: (() => void) | null = null

  constructor(private engine: Engine, private meta: { name: string; game: string; seed: number; duration: number; step: number; preload?: number }) {}

  attach(): void {
    this.detach = this.engine.observe((e, t) => this.onEvent(e, t))
  }

  stop(): void { this.detach?.(); this.detach = null }

  private onEvent(e: GameEvent, t: number): void {
    if (e.type === 'piece-captured') this.captures.push(t)
    else if (e.type === 'piece-launched') {
      const l: Launch = { t, speed: e.speed, pieceId: e.pieceId, x: e.position[0], y: e.position[1], scored: false, scoredAt: null }
      this.launches.push(l)
      this.byPiece.set(e.pieceId, l)
    } else if (e.type === 'piece-entered-sensor' && e.sensor.id.startsWith('hub-')) {
      const l = this.byPiece.get(e.pieceId)
      if (l && !l.scored && t - l.t <= SCORE_WINDOW) { l.scored = true; l.scoredAt = t }
    } else if (e.type === 'robot-impact') {
      this.hits.count++
      this.hits.hardest = Math.max(this.hits.hardest, e.speed)
    }
  }

  /** Call at a steady rate (10 Hz is plenty). */
  sample(): void {
    const f = this.engine.getFrame(false)
    const t = f.time
    const [x, y] = [f.robot[0], f.robot[1]]
    if (this.lastXY) this.distance += Math.hypot(x - this.lastXY[0], y - this.lastXY[1])
    this.lastXY = [x, y]
    const yaw = 2 * Math.atan2(f.robot[6], f.robot[3])
    this.samples.push({ t, x, y, yaw, speed: f.robotSpeed, held: f.held.length, blue: f.scores.blue, red: f.scores.red, z: f.robot[2] })
    if (f.scores.blue !== this.lastScore.blue || f.scores.red !== this.lastScore.red) {
      this.timeline.push([t, f.scores.blue, f.scores.red])
      this.lastScore = { blue: f.scores.blue, red: f.scores.red }
    }
    if (this.engine.phase !== 'delay' && this.engine.phase !== 'ended' && this.engine.phase !== 'none') this.enabledTime += t - this.lastEnabledT
    this.lastEnabledT = t
  }

  report(): RunReport {
    const f = this.engine.getFrame(false)
    const bursts = findBursts(this.launches)
    const starts = bursts.map((b) => b.start)
    const cycleTimes = starts.slice(1).map((s, i) => s - starts[i])
    const carry = carryTimes(this.captures, this.launches.map((l) => l.t), this.meta.preload ?? 0)
    const scored = this.launches.filter((l) => l.scored).length
    if (this.timeline.length === 0 || this.timeline[this.timeline.length - 1][0] < f.time) this.timeline.push([f.time, f.scores.blue, f.scores.red])
    const { preload: _preload, ...meta } = this.meta
    void _preload
    return {
      ...meta,
      final: { blue: f.scores.blue, red: f.scores.red },
      scoreTimeline: this.timeline,
      captures: this.captures,
      launches: this.launches,
      shots: this.launches.length,
      scoredShots: scored,
      accuracy: this.launches.length ? scored / this.launches.length : null,
      bursts,
      cycleTimes,
      meanCycle: cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null,
      carryTimes: carry,
      distance: this.distance,
      maxSpeed: this.samples.reduce((m, s) => Math.max(m, s.speed), 0),
      maxZ: this.samples.reduce((m, s) => Math.max(m, s.z), 0),
      hits: this.hits,
      enabledSeconds: this.enabledTime,
      status: f.status,
      samples: this.samples,
    }
  }
}

export function findBursts(launches: Launch[]): Burst[] {
  const out: Burst[] = []
  for (const l of launches) {
    const b = out[out.length - 1]
    if (b && l.t - b.end <= BURST_GAP) { b.end = l.t; b.count++; if (l.scored) b.scored++ }
    else out.push({ start: l.t, end: l.t, count: 1, scored: l.scored ? 1 : 0 })
  }
  return out
}

/** Pairs captures with launches first in, first out; the first `preload` launches fire FUEL that was loaded before the match and are skipped. */
export function carryTimes(captures: number[], launches: number[], preload = 0): number[] {
  const queue = [...captures]
  const out: number[] = []
  for (const l of launches.slice(preload)) {
    const c = queue.shift()
    if (c !== undefined && c <= l) out.push(l - c)
  }
  return out
}
