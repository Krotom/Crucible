// Smooths the robot pose in the live view. The robot sends its pose about 20 times a second; the screen draws 60 times, so the robot is drawn
// between the last two samples, one sample interval late, instead of jumping from sample to sample.

export interface Pose2 { x: number; y: number; yaw: number }
interface Sample extends Pose2 { t: number }

/** A jump longer than this between two samples is a pose reset, not driving: the robot is drawn at the new place at once. */
const SNAP_DISTANCE = 1.5 // m
const MIN_DELAY = 0.02 // s
const MAX_DELAY = 0.25 // s

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

export class PoseSmoother {
  private a: Sample | null = null
  private b: Sample | null = null
  /** moving average of the time between samples, s */
  private interval = 0.05

  /** A new pose from the robot, received at `now` (seconds, any clock that `at` also uses). Repeats of the same pose are ignored. */
  push(p: Pose2, now: number): void {
    const b = this.b
    if (b && Math.abs(b.x - p.x) < 1e-6 && Math.abs(b.y - p.y) < 1e-6 && Math.abs(b.yaw - p.yaw) < 1e-6) return
    const s: Sample = { x: p.x, y: p.y, yaw: p.yaw, t: now }
    if (!b || Math.hypot(p.x - b.x, p.y - b.y) > SNAP_DISTANCE) { this.a = s; this.b = s; return }
    const dt = now - b.t
    if (dt > 0.005 && dt < 0.5) this.interval += (dt - this.interval) * 0.2
    this.a = b
    this.b = s
  }

  /** The pose to draw at time `now`, or null before the first sample. */
  at(now: number): Pose2 | null {
    const a = this.a, b = this.b
    if (!a || !b) return null
    if (a === b) return { x: b.x, y: b.y, yaw: b.yaw }
    const delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, this.interval))
    const t = now - delay
    if (t >= b.t) return { x: b.x, y: b.y, yaw: b.yaw }
    if (t <= a.t) return { x: a.x, y: a.y, yaw: a.yaw }
    const k = (t - a.t) / (b.t - a.t)
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, yaw: a.yaw + wrap(b.yaw - a.yaw) * k }
  }

  clear(): void { this.a = null; this.b = null; this.interval = 0.05 }
}
