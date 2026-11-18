// Comparing two runs (A and B): the numbers side by side with who did better, a score-over-time chart and a drive-path overlay.
// A run is a report.json: written by `npm run batch` or by "Save run" in the Analysis tab (same shape).
import type { RunReport } from '../../../analysis/recorder'

export type Better = 'a' | 'b' | 'same' | 'none'
export interface CompareRow { label: string; a: string; b: string; delta: string; better: Better }

const NUM = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads report JSON text; fills what an older or smaller report lacks, and says what is wrong when it is not a run report at all. */
export function parseRunReport(text: string): { ok: true; report: RunReport } | { ok: false; error: string } {
  let j: unknown
  try { j = JSON.parse(text) } catch { return { ok: false, error: 'not valid JSON' } }
  if (!j || typeof j !== 'object') return { ok: false, error: 'not a run report (expected a JSON object)' }
  const r = j as Record<string, unknown>
  const fin = r.final as Record<string, unknown> | undefined
  if (!fin || !NUM(fin.blue) || !NUM(fin.red)) return { ok: false, error: 'not a run report: no final score (is this a report.json?)' }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  const hits = (r.hits ?? {}) as Record<string, unknown>
  const report: RunReport = {
    name: typeof r.name === 'string' ? r.name : 'run', game: typeof r.game === 'string' ? r.game : '', seed: NUM(r.seed) ? r.seed : 0,
    duration: NUM(r.duration) ? r.duration : 0, step: NUM(r.step) ? r.step : 0.002,
    final: { blue: fin.blue as number, red: fin.red as number },
    scoreTimeline: arr<[number, number, number]>(r.scoreTimeline).filter((p) => Array.isArray(p) && p.length >= 3 && p.every(NUM)),
    captures: arr<number>(r.captures).filter(NUM), launches: arr(r.launches),
    shots: NUM(r.shots) ? r.shots : 0, scoredShots: NUM(r.scoredShots) ? r.scoredShots : 0, accuracy: NUM(r.accuracy) ? r.accuracy : null,
    bursts: arr(r.bursts), cycleTimes: arr<number>(r.cycleTimes).filter(NUM), meanCycle: NUM(r.meanCycle) ? r.meanCycle : null, carryTimes: arr<number>(r.carryTimes).filter(NUM),
    distance: NUM(r.distance) ? r.distance : 0, maxSpeed: NUM(r.maxSpeed) ? r.maxSpeed : 0, maxZ: NUM(r.maxZ) ? r.maxZ : 0,
    hits: { count: NUM(hits.count) ? hits.count : 0, hardest: NUM(hits.hardest) ? hits.hardest : 0 }, enabledSeconds: NUM(r.enabledSeconds) ? r.enabledSeconds : 0,
    status: r.status && typeof r.status === 'object' ? (r.status as Record<string, string>) : {},
    samples: arr<{ t: number; x: number; y: number }>(r.samples).filter((s) => s && NUM(s.t) && NUM(s.x) && NUM(s.y)) as RunReport['samples'],
  }
  return { ok: true, report }
}

const median = (v: number[]): number | null => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const f = (v: number | null, d = 1): string => (v === null ? '-' : v.toFixed(d))

/** One row per number, with the difference B - A and which run did better where "better" means something. */
export function compareReports(a: RunReport, b: RunReport): CompareRow[] {
  const rows: CompareRow[] = []
  const row = (label: string, va: number | null, vb: number | null, fmt: (v: number | null) => string, better: 'high' | 'low' | 'neutral', unit = ''): void => {
    let delta = '-'
    let who: Better = 'none'
    if (va !== null && vb !== null) {
      const d = vb - va
      delta = `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt(Math.abs(d))}${unit}`
      who = Math.abs(d) < 1e-9 ? 'same' : better === 'neutral' ? 'none' : (better === 'high') === (d > 0) ? 'b' : 'a'
    }
    rows.push({ label, a: va === null ? '-' : fmt(va) + unit, b: vb === null ? '-' : fmt(vb) + unit, delta, better: who })
  }
  const int = (v: number | null): string => (v === null ? '-' : String(Math.round(v)))
  const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}`)
  row('Blue score', a.final.blue, b.final.blue, int, 'high')
  row('Red score', a.final.red, b.final.red, int, 'low')
  row('Shots', a.shots, b.shots, int, 'neutral')
  row('Shots in a HUB', a.scoredShots, b.scoredShots, int, 'high')
  row('Accuracy', a.accuracy, b.accuracy, pct, 'high', '%')
  row('Pickups', a.captures.length, b.captures.length, int, 'neutral')
  row('Mean cycle', a.meanCycle, b.meanCycle, (v) => f(v), 'low', ' s')
  row('Median pickup to launch', median(a.carryTimes), median(b.carryTimes), (v) => f(v), 'low', ' s')
  row('Driven', a.distance, b.distance, (v) => f(v), 'neutral', ' m')
  row('Top speed', a.maxSpeed, b.maxSpeed, (v) => f(v), 'neutral', ' m/s')
  row('Impacts', a.hits.count, b.hits.count, int, 'low')
  row('Hardest impact', a.hits.hardest, b.hits.hardest, (v) => f(v), 'low', ' m/s')
  return rows
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Blue score over time, A solid and B dashed (SVG text; the run names are escaped). */
export function scoreChartSvg(a: RunReport, b: RunReport, w = 380, h = 130): string {
  const tMax = Math.max(1, a.duration, b.duration, ...a.scoreTimeline.map((p) => p[0]), ...b.scoreTimeline.map((p) => p[0]))
  const yMax = Math.max(1, ...a.scoreTimeline.map((p) => p[1]), ...b.scoreTimeline.map((p) => p[1]))
  const X = (t: number): number => 28 + (t / tMax) * (w - 38), Y = (v: number): number => h - 18 - (v / yMax) * (h - 30)
  const path = (r: RunReport): string => {
    let d = ''
    r.scoreTimeline.forEach(([t, blue], i) => { d += i === 0 ? `M${X(t).toFixed(1)} ${Y(blue).toFixed(1)}` : `H${X(t).toFixed(1)}V${Y(blue).toFixed(1)}` })
    return d + `H${X(Math.max(r.duration, r.scoreTimeline.at(-1)?.[0] ?? 0)).toFixed(1)}`
  }
  return `<svg viewBox="0 0 ${w} ${h}" class="an-svg" role="img" aria-label="Blue score over time">
<text x="2" y="${Y(yMax) + 4}" class="an-axis">${yMax}</text><text x="2" y="${Y(0) + 4}" class="an-axis">0</text><text x="${X(tMax) - 2}" y="${h - 3}" class="an-axis" text-anchor="end">${tMax.toFixed(0)} s</text>
<path d="${path(a)}" fill="none" stroke="var(--blue)" stroke-width="2"/><path d="${path(b)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4"/>
<text x="${w - 4}" y="12" class="an-axis" text-anchor="end"><tspan fill="var(--blue)">A ${esc(a.name)}</tspan>  <tspan fill="var(--accent)">B ${esc(b.name)}</tspan></text></svg>`
}

/** The two drive paths on the field, A and B (field size from the longest coordinates seen when no field is given). */
export function pathChartSvg(a: RunReport, b: RunReport, fieldLength = 16.541, fieldWidth = 8.069, w = 380): string {
  const h = Math.round((w * fieldWidth) / fieldLength)
  const X = (x: number): number => (x / fieldLength) * w, Y = (y: number): number => h - (y / fieldWidth) * h
  const line = (r: RunReport, color: string, dash: string): string => (r.samples.length > 1 ? `<polyline fill="none" stroke="${color}" stroke-width="1.6" ${dash} points="${r.samples.map((s) => `${X(s.x).toFixed(1)},${Y(s.y).toFixed(1)}`).join(' ')}"/>` : '')
  return `<svg viewBox="0 0 ${w} ${h}" class="an-svg an-field" role="img" aria-label="Drive paths"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" class="field-line"/>${line(a, 'var(--blue)', '')}${line(b, 'var(--accent)', 'stroke-dasharray="6 4"')}</svg>`
}
