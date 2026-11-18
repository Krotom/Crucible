// The strategy board: draw paths and drop numbered markers on the field, keep boards by name, and turn a spot on the board into a start position.
// This file is the model (strokes, markers, undo, storage); the dialog in main.ts draws and edits it.
import type { KeyValueStore } from './presets'

const KEY = 'crucible-boards'
export type Pt = [number, number]
export interface Stroke { pts: Pt[]; color: string }
export interface Marker { x: number; y: number; label: string; color: string }
export interface Board { name: string; strokes: Stroke[]; markers: Marker[]; note: string }
export interface FieldSize { length: number; width: number }

export const COLORS = ['#e6a50a', '#4cc2ff', '#ff5566', '#5bd490', '#ffffff']
const MAX_PTS = 600, MAX_STROKES = 200, MAX_MARKERS = 60, MIN_STEP = 0.04

const clampTo = (v: number, hi: number): number => Math.min(hi, Math.max(0, v))

export function emptyBoard(name = 'Plan'): Board { return { name, strokes: [], markers: [], note: '' } }

/** A freehand line, thinned (points closer than 4 cm are dropped), clamped to the field and capped. Returns null when it is only a dot. */
export function makeStroke(raw: Pt[], field: FieldSize, color: string): Stroke | null {
  const pts: Pt[] = []
  for (const [x, y] of raw) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const p: Pt = [clampTo(x, field.length), clampTo(y, field.width)]
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP) pts.push(p)
    if (pts.length >= MAX_PTS) break
  }
  return pts.length >= 2 ? { pts, color } : null
}

export function pathLength(s: Stroke): number {
  let d = 0
  for (let i = 1; i < s.pts.length; i++) d += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1])
  return d
}

/** Heading in degrees of the first stretch of a stroke (about the first 30 cm), or null for a stroke that does not go anywhere. */
export function startHeadingDeg(s: Stroke): number | null {
  const a = s.pts[0]
  for (const p of s.pts) if (Math.hypot(p[0] - a[0], p[1] - a[1]) >= 0.3) return (Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI
  return null
}

/** Editing with undo: every change goes through here so the dialog's Undo button works for everything. */
export class BoardEditor {
  private history: string[] = []
  constructor(public board: Board, private field: FieldSize) {}

  private snap(): void { this.history.push(JSON.stringify(this.board)); if (this.history.length > 50) this.history.shift() }
  get canUndo(): boolean { return this.history.length > 0 }

  addStroke(raw: Pt[], color: string): boolean {
    const s = makeStroke(raw, this.field, color)
    if (!s || this.board.strokes.length >= MAX_STROKES) return false
    this.snap(); this.board.strokes.push(s); return true
  }

  /** Drops a marker numbered after the ones already there. */
  addMarker(x: number, y: number, color: string): Marker | null {
    if (this.board.markers.length >= MAX_MARKERS || !Number.isFinite(x) || !Number.isFinite(y)) return null
    this.snap()
    const used = new Set(this.board.markers.map((m) => m.label))
    let n = 1; while (used.has(String(n))) n++
    const m = { x: clampTo(x, this.field.length), y: clampTo(y, this.field.width), label: String(n), color }
    this.board.markers.push(m); return m
  }

  moveMarker(i: number, x: number, y: number): boolean {
    const m = this.board.markers[i]
    if (!m || !Number.isFinite(x) || !Number.isFinite(y)) return false
    this.snap(); m.x = clampTo(x, this.field.length); m.y = clampTo(y, this.field.width); return true
  }

  /** Removes the stroke or marker nearest to a point, if one is within `reach` metres. */
  eraseNear(x: number, y: number, reach = 0.4): boolean {
    let best: { kind: 'm' | 's'; i: number; d: number } | null = null
    this.board.markers.forEach((m, i) => { const d = Math.hypot(m.x - x, m.y - y); if (d <= reach && (!best || d < best.d)) best = { kind: 'm', i, d } })
    this.board.strokes.forEach((s, i) => { for (const p of s.pts) { const d = Math.hypot(p[0] - x, p[1] - y); if (d <= reach && (!best || d < best.d)) best = { kind: 's', i, d } } })
    if (!best) return false
    const b = best as { kind: 'm' | 's'; i: number }
    this.snap(); if (b.kind === 'm') this.board.markers.splice(b.i, 1); else this.board.strokes.splice(b.i, 1)
    return true
  }

  clear(): void { if (this.board.strokes.length || this.board.markers.length) { this.snap(); this.board.strokes = []; this.board.markers = [] } }
  undo(): boolean { const s = this.history.pop(); if (!s) return false; this.board = JSON.parse(s) as Board; return true }
}

function cleanBoard(b: unknown, field: FieldSize): Board | null {
  if (!b || typeof b !== 'object') return null
  const r = b as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  const strokes: Stroke[] = []
  for (const s of Array.isArray(r.strokes) ? r.strokes : []) {
    if (!s || !Array.isArray((s as Stroke).pts)) continue
    const st = makeStroke(((s as Stroke).pts as unknown[]).filter((p): p is Pt => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number'), field, typeof (s as Stroke).color === 'string' ? (s as Stroke).color.slice(0, 20) : COLORS[0])
    if (st) strokes.push(st)
  }
  const markers: Marker[] = []
  for (const m of Array.isArray(r.markers) ? r.markers : []) {
    const mm = m as Record<string, unknown>
    if (typeof mm?.x === 'number' && typeof mm.y === 'number' && Number.isFinite(mm.x) && Number.isFinite(mm.y)) markers.push({ x: clampTo(mm.x, field.length), y: clampTo(mm.y, field.width), label: typeof mm.label === 'string' ? mm.label.slice(0, 6) : String(markers.length + 1), color: typeof mm.color === 'string' ? mm.color.slice(0, 20) : COLORS[0] })
  }
  return { name: r.name.trim().slice(0, 40), strokes: strokes.slice(0, MAX_STROKES), markers: markers.slice(0, MAX_MARKERS), note: typeof r.note === 'string' ? r.note.slice(0, 500) : '' }
}

export class BoardStore {
  constructor(private store: KeyValueStore | null, private field: FieldSize) {}
  list(): Board[] {
    try {
      const raw = JSON.parse(this.store?.getItem(KEY) ?? '[]') as unknown
      return Array.isArray(raw) ? raw.map((b) => cleanBoard(b, this.field)).filter((b): b is Board => b !== null).sort((a, b) => a.name.localeCompare(b.name)) : []
    } catch { return [] }
  }
  save(b: Board): string | null {
    const name = b.name.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!name) return 'Give the board a name first'
    const all = this.list().filter((x) => x.name.toLowerCase() !== name.toLowerCase())
    if (all.length >= 30) return 'At most 30 boards: delete one first'
    all.push({ ...b, name })
    try { if (!this.store) return 'Browser storage is unavailable'; this.store.setItem(KEY, JSON.stringify(all)); return null } catch { return 'Could not store the board' }
  }
  get(name: string): Board | undefined { return this.list().find((b) => b.name.toLowerCase() === name.trim().toLowerCase()) }
  delete(name: string): boolean {
    const all = this.list(), rest = all.filter((b) => b.name.toLowerCase() !== name.trim().toLowerCase())
    if (rest.length === all.length) return false
    try { this.store?.setItem(KEY, JSON.stringify(rest)); return this.store !== null } catch { return false }
  }
}
