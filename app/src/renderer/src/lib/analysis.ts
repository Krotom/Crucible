// Match analysis: fed with every frame's events, it keeps the event feed, the score timeline and breakdown, fouls, shots (with where they were
// aimed and whether they scored), pickup-to-launch times, the robot's path and impacts. Pure data (no DOM) so it can be tested; the Analysis tab,
// the timeline and the match report are drawn from it.
import type { UiEvent } from '../../../engine/protocol'
import type { RenderFrame } from '../../../engine/types'
import type { RunReport } from '../../../analysis/recorder'

export type Side = 'blue' | 'red'
export type FeedKind = 'score' | 'foul' | 'shot' | 'pickup' | 'impact' | 'phase'
export interface FeedItem { t: number; kind: FeedKind; text: string; alliance?: Side }
export interface Shot {
  id: number; t: number
  x: number; y: number; z: number; vx: number; vy: number; vz: number; speed: number
  result: 'scored' | 'missed' | 'pending'
  /** where it came down (the HUB's centre when it scored, the no-drag ballistic estimate otherwise) */
  landX: number; landY: number
  /** seconds from the pickup of this piece to this launch, when the pickup was seen */
  pickupToLaunch: number | null
  /** sim time of the HUB entry, when it scored */
  scoredAt: number | null
}
export interface ScoreItem { t: number; alliance: Side; points: number; reason: string; phase: string; foul: boolean }
export interface PathPoint { t: number; x: number; y: number; d: number; yaw: number; speed: number; held: number; blue: number; red: number; z: number }
export interface Impact { t: number; speed: number; against: 'field' | 'robot' }

const G = 9.81
const MISS_AFTER = 3 // s after launch with no HUB entry: counted as missed
const PATH_EVERY = 0.1 // s of sim time between path samples

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue')

/** Where a launched piece comes back to the floor, ignoring drag (good enough for a map). */
export function landing(x: number, y: number, z: number, vx: number, vy: number, vz: number): { x: number; y: number; flight: number } {
  const t = Math.max(0, (vz + Math.sqrt(Math.max(0, vz * vz + 2 * G * Math.max(z, 0)))) / G)
  return { x: x + vx * t, y: y + vy * t, flight: t }
}

export function groupOfPhase(phase: string): 'Auto' | 'Teleop' | 'Endgame' | 'Other' {
  if (phase === 'auto') return 'Auto'
  if (phase === 'endgame') return 'Endgame'
  if (phase === 'teleop' || phase === 'transition' || /^shift\d$/.test(phase)) return 'Teleop'
  return 'Other'
}

export interface Summary {
  duration: number
  blue: number
  red: number
  breakdown: { label: string; blue: number; red: number }[]
  shots: { fired: number; scored: number; missed: number; pending: number; accuracy: number | null }
  pickups: number
  cycles: { n: number; mean: number; median: number; min: number; max: number } | null
  distance: number
  topSpeed: number
  impacts: { n: number; peak: number }
  fouls: ScoreItem[]
}

export class MatchRecorder {
  feed: FeedItem[] = []
  scores: ScoreItem[] = []
  /** running totals after each score: for the timeline and the score chart */
  timeline: { t: number; blue: number; red: number }[] = []
  shots: Shot[] = []
  path: PathPoint[] = []
  impacts: Impact[] = []
  phases: { t: number; name: string }[] = []
  pickups = 0
  topSpeed = 0
  maxZ = 0
  time = 0
  phase = 'none'
  status: Record<string, string> = {}
  captureTimes: number[] = []
  private captured = new Map<number, number>()
  private blue = 0
  private red = 0
  private lastPath = -Infinity
  private distance = 0

  reset(): void {
    this.feed = []; this.scores = []; this.timeline = []; this.shots = []; this.path = []; this.impacts = []; this.phases = []
    this.pickups = 0; this.topSpeed = 0; this.maxZ = 0; this.time = 0; this.phase = 'none'; this.status = {}; this.captureTimes = []
    this.captured.clear(); this.blue = 0; this.red = 0; this.lastPath = -Infinity; this.distance = 0
  }

  /** Forgets everything after time `t` (the sim was rewound or a saved state loaded). */
  truncate(t: number): void {
    const keep = <T extends { t: number }>(a: T[]): T[] => a.filter((x) => x.t <= t + 1e-9)
    this.feed = keep(this.feed); this.scores = keep(this.scores); this.timeline = keep(this.timeline); this.shots = keep(this.shots)
    this.path = keep(this.path); this.impacts = keep(this.impacts); this.phases = keep(this.phases)
    for (const [id, ct] of this.captured) if (ct > t) this.captured.delete(id)
    this.blue = this.scores.filter((s) => s.alliance === 'blue').reduce((a, s) => a + s.points, 0)
    this.red = this.scores.filter((s) => s.alliance === 'red').reduce((a, s) => a + s.points, 0)
    this.captureTimes = this.captureTimes.filter((c) => c <= t + 1e-9)
    this.pickups = this.captureTimes.length
    for (const sh of this.shots) if (sh.scoredAt !== null && sh.scoredAt > t) sh.scoredAt = null
    this.distance = this.path.length ? this.path[this.path.length - 1].d : 0
    this.lastPath = this.path.length ? this.path[this.path.length - 1].t : -Infinity
    this.phase = this.phases.length ? this.phases[this.phases.length - 1].name : 'none'
    this.time = t
    for (const s of this.shots) if (s.result !== 'scored' || s.scoredAt === null) { s.result = 'pending'; s.scoredAt = null }
  }

  ingest(f: RenderFrame, events: UiEvent[]): void {
    if (f.time < 0.0005 && this.time > 0.0005) this.reset()
    else if (f.time < this.time - 1e-9) this.truncate(f.time)
    this.time = f.time
    if (this.phase === 'none') this.phase = f.phase
    for (const e of events) this.event(e)
    // sampled path, top speed
    this.topSpeed = Math.max(this.topSpeed, f.robotSpeed)
    this.maxZ = Math.max(this.maxZ, f.robot[2])
    this.status = f.status ?? this.status
    if (f.time - this.lastPath >= PATH_EVERY - 1e-9) {
      const last = this.path[this.path.length - 1]
      if (last) this.distance += Math.hypot(f.robot[0] - last.x, f.robot[1] - last.y)
      this.path.push({ t: f.time, x: f.robot[0], y: f.robot[1], d: this.distance, yaw: 2 * Math.atan2(f.robot[6] ?? 0, f.robot[3] ?? 1), speed: f.robotSpeed, held: f.held?.length ?? 0, blue: this.blue, red: this.red, z: f.robot[2] })
      this.lastPath = f.time
    }
    // a launch that never entered a HUB is a miss once it has had time to land
    for (const s of this.shots) {
      if (s.result === 'pending' && f.time - s.t > MISS_AFTER) {
        s.result = 'missed'
        this.feed.push({ t: s.t, kind: 'shot', text: 'Shot missed' })
      }
    }
  }

  private event(e: UiEvent): void {
    switch (e.kind) {
      case 'phase':
        this.phase = e.to
        this.phases.push({ t: e.t, name: e.to })
        this.feed.push({ t: e.t, kind: 'phase', text: `Phase: ${cap(e.to)}` })
        break
      case 'score': {
        if (e.alliance === 'none') break
        const foul = /^G\d{3}/.test(e.reason)
        const item: ScoreItem = { t: e.t, alliance: e.alliance, points: e.points, reason: e.reason, phase: this.phase, foul }
        this.scores.push(item)
        if (e.alliance === 'blue') this.blue += e.points; else this.red += e.points
        this.timeline.push({ t: e.t, blue: this.blue, red: this.red })
        this.feed.push(foul
          ? { t: e.t, kind: 'foul', alliance: e.alliance, text: `Foul on ${cap(other(e.alliance))}: ${e.reason} (+${e.points} ${cap(e.alliance)})` }
          : { t: e.t, kind: 'score', alliance: e.alliance, text: `${cap(e.alliance)} +${e.points} · ${e.reason}` })
        break
      }
      case 'capture':
        this.pickups++
        this.captureTimes.push(e.t)
        this.captured.set(e.id, e.t)
        this.feed.push({ t: e.t, kind: 'pickup', text: 'Picked up FUEL' })
        break
      case 'launch': {
        const l = landing(e.x, e.y, e.z, e.vx, e.vy, e.vz)
        const picked = this.captured.get(e.id)
        this.shots.push({
          id: e.id, t: e.t, x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, speed: e.speed, result: 'pending', landX: l.x, landY: l.y,
          pickupToLaunch: picked === undefined ? null : e.t - picked, scoredAt: null,
        })
        this.feed.push({ t: e.t, kind: 'shot', text: `Shot launched at ${e.speed.toFixed(1)} m/s` })
        break
      }
      case 'sensor': {
        if (!e.enter) break
        const s = [...this.shots].reverse().find((x) => x.id === e.id && x.result === 'pending')
        if (s) {
          s.result = 'scored'; s.scoredAt = e.t; s.landX = e.x; s.landY = e.y
          this.feed.push({ t: e.t, kind: 'shot', alliance: e.alliance === 'none' ? undefined : e.alliance, text: 'Shot scored' })
        }
        break
      }
      case 'impact':
        this.impacts.push({ t: e.t, speed: e.speed, against: e.against })
        if (e.speed >= 0.5) this.feed.push({ t: e.t, kind: 'impact', text: `Impact ${e.speed.toFixed(1)} m/s (${e.against === 'robot' ? 'robot' : 'wall'})` })
        break
    }
  }

  /** The run in the same shape the command-line runner writes (report.json), so runs from the app and from `npm run batch` can be compared. */
  toRunReport(meta: { name: string; game: string; seed: number; step: number }): RunReport {
    const BURST_GAP = 1.0 // as in analysis/recorder.ts
    const shots = [...this.shots].sort((a, b) => a.t - b.t)
    const bursts: { start: number; end: number; count: number; scored: number }[] = []
    for (const s of shots) {
      const b = bursts[bursts.length - 1]
      if (b && s.t - b.end <= BURST_GAP) { b.end = s.t; b.count++; if (s.result === 'scored') b.scored++ }
      else bursts.push({ start: s.t, end: s.t, count: 1, scored: s.result === 'scored' ? 1 : 0 })
    }
    const cycleTimes = bursts.slice(1).map((b, i) => b.start - bursts[i].start)
    const scored = shots.filter((s) => s.result === 'scored').length
    const carry = shots.map((s) => s.pickupToLaunch).filter((x): x is number => x !== null)
    const peak = this.impacts.reduce((m, i) => Math.max(m, i.speed), 0)
    const dur = Math.round(this.time * 1000) / 1000
    return {
      name: meta.name, game: meta.game, seed: meta.seed, duration: dur, step: meta.step,
      final: { blue: this.blue, red: this.red },
      scoreTimeline: [[0, 0, 0], ...this.timeline.map((p): [number, number, number] => [p.t, p.blue, p.red]), [dur, this.blue, this.red]],
      captures: [...this.captureTimes],
      launches: shots.map((s) => ({ t: s.t, speed: s.speed, pieceId: s.id, x: s.x, y: s.y, scored: s.result === 'scored', scoredAt: s.scoredAt })),
      shots: shots.length, scoredShots: scored, accuracy: shots.length > 0 ? scored / shots.length : null,
      bursts, cycleTimes, meanCycle: cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null,
      carryTimes: carry, distance: this.distance, maxSpeed: this.topSpeed, maxZ: this.maxZ,
      hits: { count: this.impacts.length, hardest: peak }, enabledSeconds: dur, status: { ...this.status },
      samples: this.path.map((p) => ({ t: p.t, x: p.x, y: p.y, yaw: p.yaw, speed: p.speed, held: p.held, blue: p.blue, red: p.red, z: p.z })),
    }
  }

  summary(): Summary {
    const rows = new Map<string, { blue: number; red: number }>()
    const add = (label: string, side: Side, pts: number): void => {
      const r = rows.get(label) ?? { blue: 0, red: 0 }
      r[side] += pts
      rows.set(label, r)
    }
    for (const s of this.scores) add(s.foul ? 'Fouls' : groupOfPhase(s.phase), s.alliance, s.points)
    const order = ['Auto', 'Teleop', 'Endgame', 'Other', 'Fouls']
    const breakdown = order.filter((l) => rows.has(l) || ['Auto', 'Teleop', 'Fouls'].includes(l)).map((label) => ({ label, blue: rows.get(label)?.blue ?? 0, red: rows.get(label)?.red ?? 0 }))
    const scored = this.shots.filter((s) => s.result === 'scored').length
    const missed = this.shots.filter((s) => s.result === 'missed').length
    const decided = scored + missed
    const cyc = this.shots.map((s) => s.pickupToLaunch).filter((x): x is number => x !== null).sort((a, b) => a - b)
    const peak = this.impacts.reduce((m, i) => Math.max(m, i.speed), 0)
    return {
      duration: this.time, blue: this.blue, red: this.red, breakdown,
      shots: { fired: this.shots.length, scored, missed, pending: this.shots.length - decided, accuracy: decided > 0 ? scored / decided : null },
      pickups: this.pickups,
      cycles: cyc.length ? { n: cyc.length, mean: cyc.reduce((a, b) => a + b, 0) / cyc.length, median: cyc[Math.floor(cyc.length / 2)], min: cyc[0], max: cyc[cyc.length - 1] } : null,
      distance: this.distance, topSpeed: this.topSpeed, impacts: { n: this.impacts.length, peak },
      fouls: this.scores.filter((s) => s.foul),
    }
  }
}

/** Counts of values in equal-width bins from 0 up to `max` (the last bin takes everything above). */
export function histogram(values: number[], binWidth: number, bins: number): { from: number; to: number; count: number }[] {
  const out = Array.from({ length: bins }, (_, i) => ({ from: i * binWidth, to: (i + 1) * binWidth, count: 0 }))
  for (const v of values) out[Math.min(bins - 1, Math.max(0, Math.floor(v / binWidth)))].count++
  return out
}

export function eventsCsv(feed: FeedItem[]): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
  return ['time_s,kind,alliance,text', ...feed.map((f) => `${f.t.toFixed(3)},${f.kind},${f.alliance ?? ''},${q(f.text)}`)].join('\n') + '\n'
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export interface ReportMeta { title: string; game: string; mode: string; seed: number; version: string; date: string }

/** A self-contained HTML match report (no scripts, no external files): scores, breakdown, shots, cycle times, fouls and the event list. */
export function reportHtml(rec: MatchRecorder, meta: ReportMeta, fieldLength: number, fieldWidth: number): string {
  const sm = rec.summary()
  const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`)
  const f1 = (v: number): string => v.toFixed(1)
  const W = 520, H = 130
  const tMax = Math.max(1, rec.time)
  const maxScore = Math.max(1, ...rec.timeline.map((p) => Math.max(p.blue, p.red)))
  const line = (side: Side, color: string): string => {
    const pts = [[0, 0], ...rec.timeline.map((p) => [p.t, p[side]]), [tMax, side === 'blue' ? rec.summary().blue : rec.summary().red]]
    let d = ''
    pts.forEach(([t, v], i) => { const x = 8 + (t / tMax) * (W - 16), y = H - 12 - (v / maxScore) * (H - 28); d += i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : `H${x.toFixed(1)}V${y.toFixed(1)}` })
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`
  }
  const bins = histogram(sm.cycles ? rec.shots.map((s) => s.pickupToLaunch).filter((x): x is number => x !== null) : [], 1, 10)
  const bmax = Math.max(1, ...bins.map((b) => b.count))
  const bars = bins.map((b, i) => `<rect x="${8 + i * 50}" y="${H - 14 - (b.count / bmax) * (H - 34)}" width="44" height="${(b.count / bmax) * (H - 34)}" fill="#cb8e00"/><text x="${30 + i * 50}" y="${H - 2}" font-size="9" text-anchor="middle" fill="#777">${i}${i === 9 ? '+' : ''} s</text>`).join('')
  const MW = 520, MH = Math.round((MW * fieldWidth) / fieldLength)
  const mx = (x: number): number => (x / fieldLength) * MW, my = (y: number): number => MH - (y / fieldWidth) * MH
  const marks = rec.shots.map((s) => { const c = s.result === 'scored' ? '#2a9d5c' : s.result === 'missed' ? '#c9422e' : '#888'; return `<line x1="${mx(s.x).toFixed(1)}" y1="${my(s.y).toFixed(1)}" x2="${mx(s.landX).toFixed(1)}" y2="${my(s.landY).toFixed(1)}" stroke="${c}" stroke-width="1" opacity=".6"/><circle cx="${mx(s.x).toFixed(1)}" cy="${my(s.y).toFixed(1)}" r="3" fill="${c}"/>` }).join('')
  const pathD = rec.path.map((p, i) => `${i ? 'L' : 'M'}${mx(p.x).toFixed(1)} ${my(p.y).toFixed(1)}`).join('')
  const rows = sm.breakdown.map((r) => `<tr><td>${esc(r.label)}</td><td class="b">${r.blue}</td><td class="r">${r.red}</td></tr>`).join('')
  const fouls = sm.fouls.length ? sm.fouls.map((f) => `<li><b>${f.t.toFixed(1)} s</b> ${esc(f.reason)} (+${f.points} ${esc(f.alliance)})</li>`).join('') : '<li>none</li>'
  const feed = rec.feed.map((e) => `<tr><td>${e.t.toFixed(2)}</td><td>${esc(e.kind)}</td><td>${esc(e.text)}</td></tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:24px auto;max-width:760px;padding:0 16px;color:#1c1e21;background:#fff}
h1{margin:0 0 2px;font-size:22px}h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a87400;margin:26px 0 6px}
.sub{color:#666;font-size:12.5px}.score{font-size:34px;font-weight:700}.b{color:#1c63cf;font-weight:600}.r{color:#c8372d;font-weight:600}
table{border-collapse:collapse;width:100%}td,th{padding:3px 8px;border-bottom:1px solid #e4e1db;text-align:left}th{font-size:12px;color:#666}td:nth-child(n+2){text-align:right}
.ev td:nth-child(n+2){text-align:left}svg{background:#faf9f6;border:1px solid #e4e1db;border-radius:6px;max-width:100%}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.card{border:1px solid #e4e1db;border-radius:8px;padding:8px 10px}.card b{display:block;font-size:20px}.card span{font-size:12px;color:#666}
</style></head><body>
<h1>${esc(meta.title)}</h1><div class="sub">${esc(meta.game)} · ${esc(meta.mode)} · seed ${meta.seed} · BALTA Crucible ${esc(meta.version)} · ${esc(meta.date)} · ${f1(rec.time)} s simulated</div>
<div class="score"><span class="b">${sm.blue}</span> : <span class="r">${sm.red}</span></div>
<h2>Score breakdown</h2><table><tr><th></th><th>Blue</th><th>Red</th></tr>${rows}<tr><td><b>Total</b></td><td class="b">${sm.blue}</td><td class="r">${sm.red}</td></tr></table>
<h2>Score over time</h2><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${line('blue', '#1c63cf')}${line('red', '#c8372d')}</svg>
<h2>Robot</h2><div class="grid"><div class="card"><b>${sm.shots.fired}</b><span>shots fired</span></div><div class="card"><b>${pct(sm.shots.accuracy)}</b><span>accuracy (${sm.shots.scored} of ${sm.shots.scored + sm.shots.missed})</span></div><div class="card"><b>${sm.pickups}</b><span>pickups</span></div><div class="card"><b>${sm.cycles ? f1(sm.cycles.mean) + ' s' : '-'}</b><span>mean pickup to launch</span></div><div class="card"><b>${f1(sm.distance)} m</b><span>driven</span></div><div class="card"><b>${f1(sm.topSpeed)} m/s</b><span>top speed</span></div><div class="card"><b>${sm.impacts.n}</b><span>impacts (hardest ${f1(sm.impacts.peak)} m/s)</span></div></div>
<h2>Pickup to launch times</h2><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}</svg>
<h2>Shots and drive path</h2><svg width="${MW}" height="${MH}" viewBox="0 0 ${MW} ${MH}"><path d="${pathD}" fill="none" stroke="#9aa" stroke-width="1.5"/>${marks}</svg><div class="sub">green: scored · red: missed · grey: unknown; the line is the aim (where the shot would come down)</div>
<h2>Fouls</h2><ul>${fouls}</ul>
<h2>Events</h2><table class="ev"><tr><th>Time (s)</th><th>Kind</th><th>What</th></tr>${feed}</table>
</body></html>`
}
