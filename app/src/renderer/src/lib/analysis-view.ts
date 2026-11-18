// Draws the match recorder: the summary (also shown when a match ends), the pickup-to-launch histogram, the shot map and the event feed.
import type { FieldDefinition } from '../../../engine/types'
import { histogram, type FeedKind, type MatchRecorder, type Summary } from './analysis'

const SVG = 'http://www.w3.org/2000/svg'
const KINDS: { kind: FeedKind; id: string }[] = [
  { kind: 'score', id: 'an-k-score' }, { kind: 'foul', id: 'an-k-foul' }, { kind: 'shot', id: 'an-k-shot' },
  { kind: 'pickup', id: 'an-k-pickup' }, { kind: 'impact', id: 'an-k-impact' }, { kind: 'phase', id: 'an-k-phase' },
]
const FEED_ROWS = 400

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** The summary as DOM: score, breakdown table, key numbers, fouls. */
export function renderSummary(into: HTMLElement, s: Summary): void {
  into.textContent = ''
  const score = el('div', 'an-score')
  const b = el('b', 'blue', String(s.blue)), r = el('b', 'red', String(s.red))
  score.append(b, el('i', undefined, ':'), r)
  into.appendChild(score)

  const table = el('table', 'an-table')
  const head = el('tr')
  head.append(el('th'), el('th', undefined, 'Blue'), el('th', undefined, 'Red'))
  table.appendChild(head)
  for (const row of s.breakdown) {
    const tr = el('tr')
    tr.append(el('td', undefined, row.label), el('td', 'blue', String(row.blue)), el('td', 'red', String(row.red)))
    table.appendChild(tr)
  }
  into.appendChild(table)

  const cards: [string, string][] = [
    ['Shots', `${s.shots.fired}`], ['Accuracy', pct(s.shots.accuracy)], ['Pickups', String(s.pickups)],
    ['Mean pickup to launch', s.cycles ? `${s.cycles.mean.toFixed(1)} s` : '-'], ['Driven', `${s.distance.toFixed(1)} m`], ['Top speed', `${s.topSpeed.toFixed(1)} m/s`],
    ['Impacts', s.impacts.n ? `${s.impacts.n} (max ${s.impacts.peak.toFixed(1)} m/s)` : 'none'], ['Sim time', `${s.duration.toFixed(1)} s`],
  ]
  const grid = el('div', 'an-cards')
  for (const [k, v] of cards) { const c = el('div', 'an-card'); c.append(el('b', undefined, v), el('span', undefined, k)); grid.appendChild(c) }
  into.appendChild(grid)

  const fouls = el('div', 'an-fouls')
  fouls.appendChild(el('h4', undefined, `Fouls (${s.fouls.length})`))
  if (s.fouls.length === 0) fouls.appendChild(el('div', 'dimtext', 'none'))
  for (const f of s.fouls) fouls.appendChild(el('div', 'an-foul', `${f.t.toFixed(1)} s · ${f.reason} (+${f.points} ${f.alliance})`))
  into.appendChild(fouls)
}

export class AnalysisView {
  private field: FieldDefinition | null = null

  constructor(private rec: MatchRecorder) {}

  setField(f: FieldDefinition | null): void { this.field = f }

  enabledKinds(): Set<FeedKind> {
    const on = new Set<FeedKind>()
    for (const k of KINDS) if ($<HTMLInputElement>(k.id).checked) on.add(k.kind)
    return on
  }

  render(): void {
    renderSummary($('an-sum-body'), this.rec.summary())
    this.renderHist()
    this.renderMap()
    this.renderFeed()
  }

  private renderHist(): void {
    const box = $('an-hist')
    box.textContent = ''
    const vals = this.rec.shots.map((s) => s.pickupToLaunch).filter((x): x is number => x !== null)
    if (vals.length === 0) { box.appendChild(el('div', 'dimtext', 'No pickup-to-launch times yet (needs robot code with ball handling).')); return }
    const bins = histogram(vals, 1, 10)
    const max = Math.max(1, ...bins.map((b) => b.count))
    const W = 380, H = 110
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'an-svg' })
    bins.forEach((b, i) => {
      const h = (b.count / max) * (H - 30)
      const bar = svgEl('rect', { x: 6 + i * 37, y: H - 16 - h, width: 32, height: h, class: 'hist-bar' })
      const t = svgEl('title', {}); t.textContent = `${b.from}-${b.to}${i === bins.length - 1 ? '+' : ''} s: ${b.count}`
      bar.appendChild(t)
      svg.appendChild(bar)
      const lab = svgEl('text', { x: 22 + i * 37, y: H - 3, class: 'an-axis', 'text-anchor': 'middle' }); lab.textContent = `${i}${i === 9 ? '+' : ''}`
      svg.appendChild(lab)
      if (b.count > 0) { const n = svgEl('text', { x: 22 + i * 37, y: H - 19 - h, class: 'an-axis', 'text-anchor': 'middle' }); n.textContent = String(b.count); svg.appendChild(n) }
    })
    box.appendChild(svg)
    box.appendChild(el('div', 'dimtext', 'seconds from picking a piece up to launching it'))
  }

  private renderMap(): void {
    const box = $('an-map')
    box.textContent = ''
    const f = this.field
    if (!f) { box.appendChild(el('div', 'dimtext', 'Start a sim to see the field.')); return }
    const W = 380, H = Math.round((W * f.width) / f.length)
    const X = (x: number): number => (x / f.length) * W, Y = (y: number): number => H - (y / f.width) * H
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'an-svg an-field' })
    svg.appendChild(svgEl('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, class: 'field-line' }))
    for (const s of f.sensors) svg.appendChild(svgEl('rect', { x: X(s.center[0] - s.half[0]), y: Y(s.center[1] + s.half[1]), width: X(s.half[0] * 2), height: (s.half[1] * 2 / f.width) * H, class: s.alliance === 'red' ? 'sensor red' : 'sensor blue' }))
    if (this.rec.path.length > 1) svg.appendChild(svgEl('polyline', { points: this.rec.path.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' '), class: 'path-line' }))
    for (const s of this.rec.shots) {
      const cls = `shot-${s.result}`
      svg.appendChild(svgEl('line', { x1: X(s.x).toFixed(1), y1: Y(s.y).toFixed(1), x2: X(s.landX).toFixed(1), y2: Y(s.landY).toFixed(1), class: `shot-line ${cls}` }))
      const c = svgEl('circle', { cx: X(s.x).toFixed(1), cy: Y(s.y).toFixed(1), r: 3, class: `shot-dot ${cls}` })
      const t = svgEl('title', {}); t.textContent = `${s.t.toFixed(1)} s · ${s.speed.toFixed(1)} m/s · ${s.result}`
      c.appendChild(t)
      svg.appendChild(c)
    }
    box.appendChild(svg)
    const legend = el('div', 'dimtext', `${this.rec.shots.length} shots: green scored, red missed, grey undecided. Lines point where each came down. Grey line: the robot's path.`)
    box.appendChild(legend)
  }

  private renderFeed(): void {
    const box = $('an-feed')
    const on = this.enabledKinds()
    const items = this.rec.feed.filter((f) => on.has(f.kind))
    const shown = items.slice(-FEED_ROWS)
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 30
    box.textContent = ''
    if (shown.length === 0) { box.appendChild(el('div', 'dimtext', this.rec.feed.length ? 'Nothing matches the chips above.' : 'Nothing has happened yet.')); return }
    const frag = document.createDocumentFragment()
    for (const f of shown) {
      const row = el('div', `an-ev ${f.kind}${f.alliance ? ' ' + f.alliance : ''}`)
      row.append(el('span', 'tm', `${f.t.toFixed(1)}s`), el('span', 'tx', f.text))
      frag.appendChild(row)
    }
    box.appendChild(frag)
    $('an-feed-count').textContent = items.length > shown.length ? `last ${shown.length} of ${items.length}` : `${items.length} events`
    if (atEnd) box.scrollTop = box.scrollHeight
  }
}

/** The thin bar above the transport: the match phases to scale, score and foul markers, big impacts, and the current time. */
export class TimelineBar {
  private built = ''
  private total = 0
  private markerKey = ''

  constructor(private root: HTMLElement) {}

  private build(phases: { name: string; duration: number }[]): void {
    const key = JSON.stringify(phases)
    if (key === this.built) return
    this.built = key
    this.markerKey = ''
    this.root.textContent = ''
    const finite = phases.filter((p) => Number.isFinite(p.duration))
    this.total = finite.reduce((a, p) => a + p.duration, 0)
    const segs = el('div', 'tl-segs')
    for (const p of finite) {
      const s = el('div', `tl-seg ph-${/^shift/.test(p.name) ? 'shift' : p.name}`)
      s.style.width = `${(p.duration / this.total) * 100}%`
      s.title = `${p.name} (${p.duration} s)`
      s.appendChild(el('span', undefined, p.name))
      segs.appendChild(s)
    }
    this.root.append(segs, el('div', 'tl-markers'), el('div', 'tl-cursor'))
  }

  /** The simulated time under a horizontal pixel position (for click-to-rewind), or null before the bar has been drawn. */
  timeAt(clientX: number): number | null {
    if (this.total <= 0) return null
    const r = this.root.getBoundingClientRect()
    return Math.min(this.total, Math.max(0, ((clientX - r.left) / r.width) * this.total))
  }

  update(phases: { name: string; duration: number }[], rec: MatchRecorder, time: number): void {
    this.build(phases)
    if (this.total <= 0) return
    const x = (t: number): string => `${Math.min(100, Math.max(0, (t / this.total) * 100))}%`
    ;(this.root.querySelector('.tl-cursor') as HTMLElement).style.left = x(time)
    const key = `${rec.scores.length}|${rec.impacts.length}|${rec.shots.length}`
    if (key === this.markerKey) return
    this.markerKey = key
    const m = this.root.querySelector('.tl-markers') as HTMLElement
    m.textContent = ''
    const add = (t: number, cls: string, title: string): void => {
      const d = el('span', `tl-mark ${cls}`)
      d.style.left = x(t); d.title = title
      m.appendChild(d)
    }
    for (const s of rec.scores) add(s.t, s.foul ? `foul ${s.alliance}` : `score ${s.alliance}`, `${s.t.toFixed(1)} s · ${s.foul ? 'foul: ' : ''}${s.reason} (+${s.points} ${s.alliance})`)
    for (const i of rec.impacts) if (i.speed >= 2) add(i.t, 'hit', `${i.t.toFixed(1)} s · impact ${i.speed.toFixed(1)} m/s`)
    for (const s of rec.shots) add(s.t, `shot ${s.result}`, `${s.t.toFixed(1)} s · shot ${s.result}`)
  }
}
