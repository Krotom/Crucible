// Plot panel on uPlot: numeric topics against time, with a playback cursor and click-to-seek.
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { indexAt, type DataStore } from './store'
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

  constructor(private host: HTMLElement, private onSeek: (t: number) => void, private onChange: (names: string[]) => void) {
    this.host.style.position = 'relative'
    this.cursor = document.createElement('div')
    this.cursor.className = 'plot-cursor'
    this.host.appendChild(this.cursor)
    this.ro = new ResizeObserver(() => this.u?.setSize(this.size()))
    this.ro.observe(host)
  }

  has(name: string): boolean { return this.names.includes(name) }
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
    const plottable = this.names.filter((n) => store.series.has(n) && isNumericType(store.series.get(n)!.type))
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
    this.window = store.mode === 'live' ? [Math.max(store.tMin, store.tMax - 30), store.tMax] : [store.tMin, store.tMax]
    const [x0, x1] = this.window
    const tables: uPlot.AlignedData[] = plottable.map((n) => {
      const s = store.series.get(n)!
      const lo = Math.max(0, indexAt(s.times, x0) - 1)
      const hi = Math.min(s.times.length - 1, indexAt(s.times, x1) + 1)
      const count = hi - lo + 1
      const step = Math.max(1, Math.ceil(count / MAX_POINTS))
      const xs: number[] = []
      const ys: number[] = []
      for (let i = lo; i <= hi; i += step) {
        const v = s.get(i)
        xs.push(s.times[i])
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
        ...plottable.map((n, i) => ({ label: n.split('/').slice(-2).join('/'), stroke: COLORS[i % COLORS.length], width: 1.5, spanGaps: true, points: { show: false } })),
      ],
      hooks: {
        ready: [(u) => { u.over.addEventListener('click', (e) => { this.onSeek(u.posToVal(e.offsetX, 'x')) }) }],
      },
    }
    this.u = new uPlot(opts, data, this.host)
    this.cursor.style.display = 'block'
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
