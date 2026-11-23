// Diagnostics for tracking down memory growth. Always installed, costs nothing until the main process asks for a snapshot (it only does with --diag,
// see src/main/diag.ts). A snapshot says how big the page's own structures are, what the 3D view holds, what the controls are set to, how fast the
// page draws, and what the user did since the last snapshot (clicks, changes, key counts), so a log can be read against what was going on.
//
// Nothing here changes behaviour: the listeners only record, and the event list is capped.

export interface DiagSources {
  store: { mode: string; series: Map<string, { times: ArrayLike<number> }> }
  view: { renderer: { info: { memory: { geometries: number; textures: number }; render: { calls: number; triangles: number; lines: number; points: number }; programs?: unknown[] | null }; domElement: HTMLCanvasElement } }
  plot: { topics: string[] }
  sim: { active: boolean; latest: unknown; bridge?: unknown; requestDiag?: () => void; workerDiag?: unknown }
  recorder: unknown
  fx: { arcCount: number; markerCount: number; trailLength: number }
  robotLog: unknown
}

interface DiagEvent { t: number; type: string; what?: string; value?: string }

const EVENT_CAP = 600
let events: DiagEvent[] = []
let frames = 0
let keyCount = 0
let wheelCount = 0
let lastSnapshotAt = performance.now()
let drawn = 0

const rd = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined)
const len = (o: unknown): number | null => (o && typeof (o as { length?: unknown }).length === 'number' ? (o as { length: number }).length : null)

function describe(el: Element | null): string {
  if (!el) return ''
  const t = el.closest('button, select, input, label, summary, [data-tab], a, canvas, li, .topic') as HTMLElement | null
  const e = t ?? (el as HTMLElement)
  const id = e.id ? `#${e.id}` : ''
  const tab = e.getAttribute?.('data-tab') ? `[data-tab=${e.getAttribute('data-tab')}]` : ''
  const text = (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  return `${e.tagName.toLowerCase()}${id}${tab}${text ? ` "${text}"` : ''}`
}

function push(e: DiagEvent): void {
  events.push(e)
  if (events.length > EVENT_CAP) events = events.slice(-EVENT_CAP)
}

/** Starts recording what the user does and counting drawn frames. */
export function installDiag(src: DiagSources): void {
  const w = window as unknown as Record<string, unknown>
  const now = (): number => Math.round(performance.now())
  document.addEventListener('click', (ev) => push({ t: now(), type: 'click', what: describe(ev.target as Element) }), true)
  document.addEventListener('change', (ev) => { const t = ev.target as HTMLInputElement; push({ t: now(), type: 'change', what: describe(t), value: t.type === 'checkbox' ? String(t.checked) : String(t.value).slice(0, 40) }) }, true)
  document.addEventListener('keydown', () => { keyCount++ }, true)
  document.addEventListener('wheel', () => { wheelCount++ }, { capture: true, passive: true })
  document.addEventListener('visibilitychange', () => push({ t: now(), type: 'visibility', value: document.visibilityState }))
  window.addEventListener('focus', () => push({ t: now(), type: 'focus' }))
  window.addEventListener('blur', () => push({ t: now(), type: 'blur' }))
  window.addEventListener('resize', () => push({ t: now(), type: 'resize', value: `${innerWidth}x${innerHeight}` }))
  window.addEventListener('error', (e) => push({ t: now(), type: 'error', value: String(e.message).slice(0, 160) }))
  window.addEventListener('unhandledrejection', (e) => push({ t: now(), type: 'rejection', value: String((e.reason as Error)?.message ?? e.reason).slice(0, 160) }))
  // video capture is the one feature that keeps a lot of data on purpose
  const MR = (window as unknown as { MediaRecorder?: { prototype: { start: (...a: unknown[]) => void; stop: () => void } } }).MediaRecorder
  if (MR) {
    const start = MR.prototype.start, stop = MR.prototype.stop
    MR.prototype.start = function (this: unknown, ...a: unknown[]) { push({ t: now(), type: 'recording-start' }); return start.apply(this, a) }
    MR.prototype.stop = function (this: unknown) { push({ t: now(), type: 'recording-stop' }); return stop.apply(this) }
  }
  const loop = (): void => { frames++; requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  w.__diag = () => snapshot(src)
}

function controls(): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select[id], input[id]')) {
    if (++n > 120) break
    out[el.id] = el.type === 'checkbox' ? String((el as HTMLInputElement).checked) : String(el.value).slice(0, 30)
  }
  return out
}

function snapshot(src: DiagSources): Record<string, unknown> {
  const t = performance.now()
  const seconds = Math.max(0.001, (t - lastSnapshotAt) / 1000)
  lastSnapshotAt = t
  const fps = frames / seconds
  frames = 0
  drawn++
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
  const info = src.view.renderer.info
  // the series with the most samples, and the totals
  let samples = 0
  const sizes: [string, number][] = []
  for (const [name, s] of src.store.series) { const n = s.times.length; samples += n; sizes.push([name, n]) }
  sizes.sort((a, b) => b[1] - a[1])
  const latest = src.sim.latest as Record<string, unknown> | null
  const bridge = src.sim.bridge as Record<string, unknown> | undefined
  const canvases = [...document.querySelectorAll('canvas')].map((c) => `${c.id || c.className || 'canvas'}:${c.width}x${c.height}`).slice(0, 12)
  const tab = [...document.querySelectorAll<HTMLElement>('[data-tab]')].find((e) => e.classList.contains('active') || e.classList.contains('on') || e.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab') ?? null
  const rec = src.recorder as Record<string, unknown>
  const log = src.robotLog as Record<string, unknown>
  src.sim.requestDiag?.() // the physics worker answers in time for the next snapshot
  const out = {
    snapshot: drawn,
    page: {
      fps: +fps.toFixed(1), keys: keyCount, wheel: wheelCount, visible: document.visibilityState, focused: document.hasFocus(),
      window: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, domNodes: document.getElementsByTagName('*').length, canvases, tab,
    },
    heap: mem ? { usedMB: Math.round(mem.usedJSHeapSize / 1048576), totalMB: Math.round(mem.totalJSHeapSize / 1048576), limitMB: Math.round(mem.jsHeapSizeLimit / 1048576) } : null,
    three: {
      geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs ? info.programs.length : null,
      calls: info.render.calls, triangles: info.render.triangles, lines: info.render.lines, points: info.render.points,
      canvas: `${src.view.renderer.domElement.width}x${src.view.renderer.domElement.height}`,
    },
    fx: { arcs: src.fx.arcCount, markers: src.fx.markerCount, trail: src.fx.trailLength },
    store: { mode: src.store.mode, series: src.store.series.size, samples, top: sizes.slice(0, 4), plotted: src.plot.topics.length },
    recorder: { path: len(rd(rec, 'path')), shots: len(rd(rec, 'shots')), feed: len(rd(rec, 'feed')), timeline: len(rd(rec, 'timeline')), impacts: len(rd(rec, 'impacts')) },
    robotLog: { entries: len(rd(log, 'entries')) },
    sim: latest ? {
      active: src.sim.active, time: +Number(latest.time).toFixed(1), pieces: latest.pieceCount, awake: latest.awakeCount, held: len(latest.held),
      shots: latest.shots, others: len(latest.others),
    } : { active: src.sim.active },
    bridge: bridge ? { connected: bridge.connected, frames: bridge.frames, skipped: bridge.skipped, rttMs: bridge.rttMs, leadMs: bridge.leadMs, enabled: bridge.robotEnabled } : null,
    worker: src.sim.workerDiag ?? null,
    controls: controls(),
    events: events,
  }
  events = []
  return out
}
