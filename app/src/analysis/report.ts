// Turns RunReports into text a person reads: a Markdown summary, a self-contained HTML page with charts (score over time, speed, a field map of
// the drive path, shots and pickups), and a comparison table across runs.
import type { RunReport } from './recorder'
import { brandFooter, brandHeader, REPORT_STYLE } from './theme'

const fmt = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d))
const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`)
const median = (a: number[]): number | null => {
  if (!a.length) return null
  const s = [...a].sort((p, q) => p - q)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

export function summaryLines(r: RunReport): string[] {
  return [
    `score        blue ${r.final.blue}   red ${r.final.red}`,
    `shots        ${r.shots} fired, ${r.scoredShots} in a HUB (${pct(r.accuracy)})`,
    `pickups      ${r.captures.length}`,
    `bursts       ${r.bursts.length}${r.bursts.length ? ` (${r.bursts.map((b) => `${b.scored}/${b.count}`).join(', ')} scored/fired)` : ''}`,
    `cycle time   mean ${fmt(r.meanCycle)} s, median ${fmt(median(r.cycleTimes))} s over ${r.cycleTimes.length} cycles`,
    `carry time   median ${fmt(median(r.carryTimes))} s from pickup to launch`,
    `driven       ${fmt(r.distance, 1)} m, top speed ${fmt(r.maxSpeed)} m/s, highest ${fmt(r.maxZ - 0.12, 2)} m over the floor`,
    `contacts     ${r.hits.count}, hardest ${fmt(r.hits.hardest)} m/s`,
    `enabled      ${fmt(r.enabledSeconds, 1)} s of ${fmt(r.duration, 1)} s`,
  ]
}

export function toMarkdown(r: RunReport): string {
  const lines = [`# ${r.name}`, '', `${r.game}, seed ${r.seed}, ${r.duration} s simulated in ${r.step * 1000} ms steps`, '', '```', ...summaryLines(r), '```', '']
  if (Object.keys(r.status).length) lines.push('Game status at the end:', '', '```', ...Object.entries(r.status).map(([k, v]) => `${k.padEnd(8)} ${v}`), '```', '')
  if (r.launches.length) {
    lines.push('| # | time (s) | exit speed (m/s) | from (x, y) | result |', '|---|---|---|---|---|')
    r.launches.slice(0, 60).forEach((l, i) => lines.push(`| ${i + 1} | ${fmt(l.t)} | ${fmt(l.speed)} | ${fmt(l.x, 1)}, ${fmt(l.y, 1)} | ${l.scored ? `HUB at ${fmt(l.scoredAt)} s` : 'missed'} |`))
    if (r.launches.length > 60) lines.push('', `(${r.launches.length - 60} more)`)
  }
  return lines.join('\n') + '\n'
}

/** One row per run. */
export function comparisonTable(rs: RunReport[]): string {
  const rows = ['| run | blue | red | shots | scored | accuracy | cycles | mean cycle (s) | driven (m) | contacts |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rs) rows.push(`| ${r.name} | ${r.final.blue} | ${r.final.red} | ${r.shots} | ${r.scoredShots} | ${pct(r.accuracy)} | ${r.cycleTimes.length} | ${fmt(r.meanCycle)} | ${fmt(r.distance, 1)} | ${r.hits.count} |`)
  return rows.join('\n') + '\n'
}

// ---- charts (inline SVG; colors come from CSS variables so they follow light and dark)

export interface Series { label: string; color: string; points: [number, number][] }

export function lineChart(title: string, series: Series[], w: number, h: number, yLabel: string): string {
  const pad = { l: 44, r: 12, t: 26, b: 28 }
  const all = series.flatMap((s) => s.points)
  if (!all.length) return ''
  const xMax = Math.max(...all.map((p) => p[0]), 1e-9)
  const yMax = Math.max(...all.map((p) => p[1]), 1e-9) * 1.1
  const X = (x: number): number => pad.l + (x / xMax) * (w - pad.l - pad.r)
  const Y = (y: number): number => h - pad.b - (y / yMax) * (h - pad.t - pad.b)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const grid = ticks.map((k) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(k * yMax)}" y2="${Y(k * yMax)}" class="grid"/><text x="${pad.l - 6}" y="${Y(k * yMax) + 4}" class="tick" text-anchor="end">${fmt(k * yMax, yMax < 10 ? 1 : 0)}</text>`).join('')
  const xt = [0, 0.25, 0.5, 0.75, 1].map((k) => `<text x="${X(k * xMax)}" y="${h - 8}" class="tick" text-anchor="middle">${fmt(k * xMax, 0)}</text>`).join('')
  const paths = series.map((s) => {
    // steps for score-like series would hide the shape; plain lines read fine at this resolution
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>`
  }).join('')
  const legend = series.map((s, i) => `<g transform="translate(${pad.l + i * 90},14)"><rect width="10" height="10" y="-9" fill="${s.color}"/><text x="14" class="tick">${s.label}</text></g>`).join('')
  return `<figure><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}"><text x="${pad.l}" y="10" class="cap" display="none">${title}</text>${grid}${xt}<text x="12" y="${pad.t + 6}" class="tick" transform="rotate(-90 12 ${h / 2})" text-anchor="middle">${yLabel}</text>${paths}${legend}</svg><figcaption>${title}</figcaption></figure>`
}

function fieldMap(r: RunReport, fieldLength = 16.54, fieldWidth = 8.07): string {
  const w = 640
  const h = (w * fieldWidth) / fieldLength
  const X = (x: number): number => (x / fieldLength) * w
  const Y = (y: number): number => h - (y / fieldWidth) * h
  const path = r.samples.map((s, i) => `${i ? 'L' : 'M'}${X(s.x).toFixed(1)},${Y(s.y).toFixed(1)}`).join('')
  const shots = r.launches.map((l) => `<circle cx="${X(l.x)}" cy="${Y(l.y)}" r="5" class="${l.scored ? 'hit' : 'miss'}"/>`).join('')
  return `<figure><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="field map"><rect width="${w}" height="${h}" class="field"/><line x1="${w / 2}" x2="${w / 2}" y1="0" y2="${h}" class="grid"/><path d="${path}" fill="none" class="path"/>${shots}</svg><figcaption>Drive path; shots (filled: reached a HUB, open: missed)</figcaption></figure>`
}

const STYLE = REPORT_STYLE

/** A complete HTML page around some body markup, in the report style. */
export function page(title: string, sub: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>
${brandHeader('Report')}<h1>${title}</h1><p class="sub">${sub}</p>
${body}
${brandFooter()}</main></body></html>`
}

export function toHtml(r: RunReport): string {
  const step = (s: [number, number, number][], idx: 1 | 2): [number, number][] => s.map((p) => [p[0], p[idx]])
  const charts = [
    lineChart('Score over time', [{ label: 'blue', color: 'var(--blue)', points: step(r.scoreTimeline, 1) }, { label: 'red', color: 'var(--red)', points: step(r.scoreTimeline, 2) }], 640, 220, 'points'),
    lineChart('Robot speed', [{ label: 'speed', color: 'var(--accent)', points: r.samples.map((s) => [s.t, s.speed]) }], 640, 180, 'm/s'),
    lineChart('FUEL held in the robot', [{ label: 'held', color: 'var(--blue)', points: r.samples.map((s) => [s.t, s.held]) }], 640, 160, 'count'),
    fieldMap(r),
  ].join('')
  const rows = r.launches.slice(0, 80).map((l, i) => `<tr><td>${i + 1}</td><td>${fmt(l.t)}</td><td>${fmt(l.speed)}</td><td>${fmt(l.x, 1)}, ${fmt(l.y, 1)}</td><td>${l.scored ? `HUB at ${fmt(l.scoredAt)} s` : 'missed'}</td></tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.name} run report</title><style>${STYLE}</style></head><body><main>
${brandHeader('Run report')}<h1>${r.name}</h1><p class="sub">${r.game}, seed ${r.seed}, ${r.duration} s simulated in ${r.step * 1000} ms steps</p>
<pre>${summaryLines(r).join('\n')}</pre>${charts}
<h2>Shots</h2><table><tr><th>#</th><th>time (s)</th><th>exit speed (m/s)</th><th>from (x, y)</th><th>result</th></tr>${rows}</table>
${brandFooter()}</main></body></html>`
}
