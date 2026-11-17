// One data model for both sources: a recorded log or a live NetworkTables connection.
import { decodeRaw, type Value } from './structs'
import type { ParsedLog } from './wpilog'

export interface Series {
  name: string
  type: string
  /** Sample times in seconds, ascending. */
  times: number[]
  get(i: number): Value
}

export type Mode = 'none' | 'log' | 'live'

class LogSeries implements Series {
  times: number[]
  constructor(public name: string, public type: string, private buf: Uint8Array, private offsets: number[], private lengths: number[], times: number[]) {
    this.times = times
  }
  get(i: number): Value {
    return decodeRaw(this.type, this.buf.subarray(this.offsets[i], this.offsets[i] + this.lengths[i]))
  }
}

const LIVE_CAP = 60000

export class LiveSeries implements Series {
  times: number[] = []
  private values: Value[] = []
  constructor(public name: string, public type: string) {}
  push(t: number, v: Value): void {
    this.times.push(t)
    this.values.push(v)
    if (this.times.length > LIVE_CAP + 5000) { this.times.splice(0, 5000); this.values.splice(0, 5000) }
  }
  get(i: number): Value { return this.values[i] }
}

/** Index of the last sample at or before t, or -1. */
export function indexAt(times: number[], t: number): number {
  let lo = 0
  let hi = times.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

export class DataStore {
  mode: Mode = 'none'
  label = ''
  series = new Map<string, Series>()
  tMin = 0
  tMax = 0
  truncated = false
  private listeners = new Set<() => void>()

  onTopicsChanged(fn: () => void): void { this.listeners.add(fn) }
  private emit(): void { this.listeners.forEach((f) => f()) }

  clear(): void {
    this.mode = 'none'; this.label = ''; this.series.clear(); this.tMin = 0; this.tMax = 0; this.truncated = false
    this.emit()
  }

  loadLog(log: ParsedLog, label: string): void {
    this.series.clear()
    for (const e of log.entries) {
      if (e.times.length === 0) continue
      this.series.set(e.name, new LogSeries(e.name, e.type, log.buffer, e.offsets, e.lengths, e.times))
    }
    this.mode = 'log'; this.label = label
    this.tMin = log.tMin; this.tMax = log.tMax; this.truncated = log.truncated
    this.emit()
  }

  startLive(label: string): void {
    this.series.clear()
    this.mode = 'live'; this.label = label
    this.tMin = 0; this.tMax = 0; this.truncated = false
    this.emit()
  }

  liveSeries(name: string, type: string): LiveSeries {
    let s = this.series.get(name) as LiveSeries | undefined
    if (!s || s.type !== type) {
      s = new LiveSeries(name, type)
      this.series.set(name, s)
      this.emit()
    }
    return s
  }

  /** Called by the live source for every sample so the timeline knows how far the data reaches. */
  touchLive(t: number): void {
    if (this.tMin === 0 && this.tMax === 0) this.tMin = t
    if (t > this.tMax) this.tMax = t
  }

  valueAt(name: string, t: number): Value | undefined {
    const s = this.series.get(name)
    if (!s || s.times.length === 0) return undefined
    const i = indexAt(s.times, t)
    return i < 0 ? undefined : s.get(i)
  }

  topicNames(): string[] { return [...this.series.keys()].sort() }
}
