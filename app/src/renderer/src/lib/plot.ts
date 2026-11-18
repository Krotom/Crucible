// Plot panel on uPlot: numeric topics against time, with a playback cursor and click-to-seek.
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { indexAt, type DataStore, type Series } from './store'
import { isNumericType } from './structs'

const COLORS = ['#4cc2ff', '#ff9f43', '#7bed9f', '#ff6b81', '#c58bff', '#f6e05e', '#5eead4', '#fb923c']
const MAX_POINTS = 6000

export class PlotPanel {
  private u: uPlot | null = null
  private names: string[] = []
  private cursor: HTMLDivElement
  private ro: ResizeObserver
  private lastBuild = 0
  private window: [number, number] | null = null
  /** a second log whose topics (named `ref:<topic>`) are drawn dashed on the same time axis, shifted so its start lines up with the main data */
  private ref: { store: DataStore; offset: () => number } | null = null

  constructor(private host: HTMLElement, private onSeek: (t: number) => void, private onChange: (names: string[]) => void) {
    this.host.style.position = 'relative'
    this.cursor = document.createElement('div')
    this.cursor.className = 'plot-cursor'
    this.host.appendChild(this.cursor)
    this.ro = new ResizeObserver(() => this.u?.setSize(this.size()))
    this.ro.observe(host)
  }

  has(name: string): boolean { return this.names.includes(name) }

  setReference(store: DataStore | null, offset: () => number = () => 0): void { this.ref = store ? { store, offset } : null }
  /** Takes the reference topics off the plot (the reference log was closed). */
  dropReference(): void { this.names = this.names.filter((n) => !n.startsWith('ref:')) }

  /** The series behind a plotted name and how far its times are shifted onto the main time axis (0 for the main data). */
  private resolve(name: string, store: DataStore): { s: Series; shift: number } | null {
    if (name.startsWith('ref:')) {
      const s = this.ref?.store.series.get(name.slice(4))
      return s && this.ref ? { s, shift: store.tMin - this.ref.store.tMin + this.ref.offset() } : null
    }
    const s = store.series.get(name)
    return s ? { s, shift: 0 } : null
  }
  get topics(): string[] { return [...this.names] }

  toggle(name: string, store: DataStore): void {
    const i = this.names.indexOf(name)
    if (i >= 0) this.names.splice(i, 1)
    else this.names.push(name)
    this.build(store, true)
    this.onChange(this.topics)
  }

  clear(store: DataStore): void {
    this.names = []
    this.build(store, true)
    this.onChange(this.topics)
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(100, this.host.clientWidth), height: Math.max(60, this.host.clientHeight) }
  }

  /** Rebuild the chart; throttled to 4 Hz unless forced (live data arrives continuously). */
  build(store: DataStore, force = false): void {
    const now = performance.now()
    if (!force && now - this.lastBuild < 250) return
    this.lastBuild = now
    const plottable = this.names.filter((n) => { const r = this.resolve(n, store); return r !== null && isNumericType(r.s.type) })
    this.u?.destroy()
    this.u = null
    this.host.querySelector('.plot-empty')?.remove()
    if (plottable.length === 0) {
      const d = document.createElement('div')
      d.className = 'plot-empty'
      d.textContent = 'Click a numeric topic in the list to plot it.'
      this.host.appendChild(d)
      this.cursor.style.display = 'none'
      return
    }
    // the time window: the main data's (the last 30 s while live); with no main data, the span of the reference
    const mainEmpty = store.mode === 'none'
    const refSpan = this.ref ? this.ref.store.tMax - this.ref.store.tMin : 0
    this.window = mainEmpty ? [0, Math.max(1, refSpan)] : store.mode === 'live' ? [Math.max(store.tMin, store.tMax - 30), store.tMax] : [store.tMin, store.tMax]
    const [x0, x1] = this.window
    const tables: uPlot.AlignedData[] = plottable.map((n) => {
      const { s, shift } = this.resolve(n, mainEmpty ? { ...store, tMin: 0 } as DataStore : store)!
      const lo = Math.max(0, indexAt(s.times, x0 - shift) - 1)
      const hi = Math.min(s.times.length - 1, indexAt(s.times, x1 - shift) + 1)
      const count = hi - lo + 1
      const step = Math.max(1, Math.ceil(count / MAX_POINTS))
      const xs: number[] = []
      const ys: number[] = []
      for (let i = lo; i <= hi; i += step) {
        const v = s.get(i)
        xs.push(s.times[i] + shift)
        ys.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as number))
      }
      return [xs, ys]
    })
    const data = uPlot.join(tables)
    const opts: uPlot.Options = {
      ...this.size(),
      scales: { x: { time: false, range: () => [x0, x1] } },
      cursor: { drag: { x: false, y: false } },
      legend: { live: true },
      axes: [
        { stroke: '#8b95a3', grid: { stroke: '#232830' }, ticks: { stroke: '#2d343d' } },
        { stroke: '#8b95a3', grid: { stroke: '#232830' }, ticks: { stroke: '#2d343d' }, size: 60 },
      ],
      series: [
        { label: 't (s)' },
        ...plottable.map((n, i) => ({ label: (n.startsWith('ref:') ? 'ref ' : '') + n.replace(/^ref:/, '').split('/').slice(-2).join('/'), stroke: COLORS[i % COLORS.length], width: 1.5, spanGaps: true, points: { show: false }, ...(n.startsWith('ref:') ? { dash: [6, 4] } : {}) })),
      ],
      hooks: {
        ready: [(u) => { u.over.addEventListener('click', (e) => { this.onSeek(u.posToVal(e.offsetX, 'x')) }) }],
      },
    }
    this.u = new uPlot(opts, data, this.host)
    this.cursor.style.display = 'block'
  }

  /** The plotted topics as CSV: every sample of every plotted topic (not just the visible window), long form: topic,time_s,value. */
  csv(store: DataStore): string {
    const q = (v: string): string => `"${v.replace(/"/g, '""')}"`
    const out = ['topic,time_s,value']
    for (const n of this.names) {
      const r = this.resolve(n, store)
      if (!r || !isNumericType(r.s.type)) continue
      const { s, shift } = r
      for (let i = 0; i < s.times.length; i++) {
        const v = s.get(i)
        out.push(`${q(n)},${s.times[i] + shift},${typeof v === 'boolean' ? (v ? 1 : 0) : v}`)
      }
    }
    return out.join('\n') + '\n'
  }

  /** The chart as a PNG with its legend (uPlot's legend is HTML, so it is drawn onto the image here). */
  png(): Promise<Blob | null> {
    const u = this.u
    if (!u) return Promise.resolve(null)
    const src = u.root.querySelector('canvas') as HTMLCanvasElement
    const labels = this.names.map((n, i) => ({ text: n, color: COLORS[i % COLORS.length] }))
    const lh = 18 * Math.ceil(labels.length / 2) + 8
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height + lh * (src.width / Math.max(1, this.host.clientWidth))
    const k = src.width / Math.max(1, this.host.clientWidth)
    const g = c.getContext('2d')!
    g.fillStyle = '#111316'
    g.fillRect(0, 0, c.width, c.height)
    g.font = `${12 * k}px system-ui, sans-serif`
    labels.forEach((l, i) => {
      const x = (8 + (i % 2) * (this.host.clientWidth / 2)) * k, y = (14 + Math.floor(i / 2) * 18) * k
      g.fillStyle = l.color; g.fillRect(x, y - 9 * k, 14 * k, 3 * k)
      g.fillStyle = '#dcdcdc'; g.fillText(l.text.length > 46 ? '…' + l.text.slice(-45) : l.text, x + 20 * k, y)
    })
    g.drawImage(src, 0, lh * k)
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'))
  }

  setCursor(t: number): void {
    if (!this.u || !this.window) return
    const left = this.u.valToPos(t, 'x')
    const over = this.u.over
    if (!Number.isFinite(left) || left < 0 || left > over.clientWidth) { this.cursor.style.display = 'none'; return }
    this.cursor.style.display = 'block'
    this.cursor.style.left = `${over.offsetLeft + left}px`
    this.cursor.style.top = `${over.offsetTop}px`
    this.cursor.style.height = `${over.clientHeight}px`
  }
}
