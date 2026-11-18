// The attempts scoreboard: one row per finished match (or scenario) so a practice session can be compared with itself: best, average, trend.
// Kept in local storage; a note per attempt ("new shooter hood", "battery at 11.8 V") makes the list useful a week later.
import type { KeyValueStore } from './presets'

const KEY = 'crucible-attempts'
const MAX = 200
export interface Attempt {
  at: number
  /** what the team called it: the game and seed unless it was renamed */
  label: string
  own: 'blue' | 'red'
  blue: number
  red: number
  duration: number
  shots: number
  /** 0..1, null with no shots */
  accuracy: number | null
  fouls: number
  note: string
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

function clean(a: unknown): Attempt | null {
  if (!a || typeof a !== 'object') return null
  const r = a as Record<string, unknown>
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  return {
    at: r.at, label: typeof r.label === 'string' ? r.label.slice(0, 80) : 'match', own: r.own === 'red' ? 'red' : 'blue', blue: num(r.blue), red: num(r.red), duration: num(r.duration),
    shots: num(r.shots), accuracy: typeof r.accuracy === 'number' && Number.isFinite(r.accuracy) ? Math.min(1, Math.max(0, r.accuracy)) : null, fouls: num(r.fouls), note: typeof r.note === 'string' ? r.note.slice(0, 200) : '',
  }
}

/** The team's own score, the other alliance's, and the margin. */
export const ownScore = (a: Attempt): number => (a.own === 'red' ? a.red : a.blue)
export const otherScore = (a: Attempt): number => (a.own === 'red' ? a.blue : a.red)
export const margin = (a: Attempt): number => ownScore(a) - otherScore(a)

export interface AttemptStats { n: number; best: number | null; worst: number | null; mean: number | null; wins: number; losses: number; ties: number; /** mean of the last 3 minus mean of the 3 before, null with fewer than 6 attempts */ trend: number | null }

export function statsOf(list: Attempt[]): AttemptStats {
  const own = list.map(ownScore)
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length
  const n = own.length
  return {
    n, best: n ? Math.max(...own) : null, worst: n ? Math.min(...own) : null, mean: n ? mean(own) : null,
    wins: list.filter((a) => margin(a) > 0).length, losses: list.filter((a) => margin(a) < 0).length, ties: list.filter((a) => margin(a) === 0).length,
    trend: n >= 6 ? mean(own.slice(-3)) - mean(own.slice(-6, -3)) : null,
  }
}

export class AttemptLog {
  constructor(private store: KeyValueStore | null) {}

  list(): Attempt[] {
    try {
      const raw = JSON.parse(this.store?.getItem(KEY) ?? '[]') as unknown
      return Array.isArray(raw) ? raw.map(clean).filter((a): a is Attempt => a !== null).sort((a, b) => a.at - b.at) : []
    } catch { return [] }
  }

  private write(all: Attempt[]): boolean { try { this.store?.setItem(KEY, JSON.stringify(all.slice(-MAX))); return this.store !== null } catch { return false } }

  /** Adds an attempt (ignored when one with the same time already exists: a match that ends twice is one attempt). */
  add(a: Attempt): boolean {
    const c = clean(a)
    if (!c) return false
    const all = this.list()
    if (all.some((x) => x.at === c.at)) return false
    all.push(c)
    return this.write(all.sort((x, y) => x.at - y.at))
  }

  setNote(at: number, note: string): boolean {
    const all = this.list(), a = all.find((x) => x.at === at)
    if (!a) return false
    a.note = note.slice(0, 200)
    return this.write(all)
  }

  remove(at: number): boolean { const all = this.list(), rest = all.filter((x) => x.at !== at); return rest.length !== all.length && this.write(rest) }
  clear(): void { this.write([]) }

  csv(): string {
    const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
    const head = 'time,label,alliance,own,other,margin,duration_s,shots,accuracy_pct,fouls,note'
    return [head, ...this.list().map((a) => [new Date(a.at).toISOString(), q(a.label), a.own, ownScore(a), otherScore(a), margin(a), a.duration.toFixed(1), a.shots, a.accuracy === null ? '' : Math.round(a.accuracy * 100), a.fouls, q(a.note)].join(','))].join('\n') + '\n'
  }
}
