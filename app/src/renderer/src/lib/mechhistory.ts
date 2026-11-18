// A short history of every mechanism's position, speed, applied voltage and current (the last seconds), and the little line charts drawn from it.
export interface MechSample { t: number; position: number; velocity: number; volts: number; amps: number }
export type MechField = 'position' | 'velocity' | 'volts' | 'amps'

export class MechHistory {
  readonly series = new Map<string, MechSample[]>()
  /** seconds of history kept */
  constructor(private seconds = 10, private every = 0.05) {}

  clear(): void { this.series.clear() }

  /** Adds the mechanisms of one frame (a sample at most every `every` s of sim time; going back in time cuts the history there). */
  add(t: number, mechs: { name: string; position: number; velocity: number; volts: number; amps: number }[]): void {
    for (const m of mechs) {
      let a = this.series.get(m.name)
      if (!a) { a = []; this.series.set(m.name, a) }
      // time went back (rewind, Load, Reset): forget everything from that moment on, the sample at exactly that time included
      if (a.length > 0 && t < a[a.length - 1].t - 1e-9) while (a.length > 0 && a[a.length - 1].t >= t - 1e-9) a.pop()
      const last = a[a.length - 1]
      if (last && t - last.t < this.every - 1e-9) continue
      a.push({ t, position: m.position, velocity: m.velocity, volts: m.volts, amps: m.amps })
      while (a.length > 0 && a[0].t < t - this.seconds) a.shift()
    }
  }

  names(): string[] { return [...this.series.keys()] }
}

/** SVG path of a line chart of values in a w x h box; a flat series sits in the middle. `lo` / `hi` pin the scale (otherwise from the data). */
export function sparkPath(values: number[], w: number, h: number, lo?: number, hi?: number): string {
  if (values.length < 2) return ''
  let a = lo ?? Math.min(...values), b = hi ?? Math.max(...values)
  if (b - a < 1e-9) { a -= 0.5; b += 0.5 }
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * w).toFixed(1)} ${(h - 2 - ((Math.min(b, Math.max(a, v)) - a) / (b - a)) * (h - 4)).toFixed(1)}`).join('')
}

const FIELDS: { key: MechField; label: string; unit: string; digits: number }[] = [
  { key: 'position', label: 'position', unit: 'rot', digits: 2 }, { key: 'velocity', label: 'speed', unit: 'rps', digits: 1 },
  { key: 'volts', label: 'voltage', unit: 'V', digits: 1 }, { key: 'amps', label: 'current', unit: 'A', digits: 0 },
]

const SVG = 'http://www.w3.org/2000/svg'

/** The inspector: one row per mechanism with four small charts and their latest values. Rows are built once and updated in place. */
export class MechInspector {
  private rows = new Map<string, { paths: Record<MechField, SVGPathElement>; vals: Record<MechField, HTMLElement> }>()

  constructor(private root: HTMLElement) {}

  update(h: MechHistory): void {
    const names = h.names()
    if (names.length === 0) { this.root.textContent = ''; this.rows.clear(); return }
    for (const n of names) {
      let r = this.rows.get(n)
      if (!r) {
        const row = document.createElement('div'); row.className = 'mi-row'
        const title = document.createElement('div'); title.className = 'mi-name'; title.textContent = n
        row.appendChild(title)
        const paths = {} as Record<MechField, SVGPathElement>, vals = {} as Record<MechField, HTMLElement>
        const grid = document.createElement('div'); grid.className = 'mi-grid'
        for (const f of FIELDS) {
          const cell = document.createElement('div'); cell.className = 'mi-cell'; cell.title = `${n} ${f.label} over the last seconds`
          const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 100 26'); svg.setAttribute('class', 'mi-svg')
          const p = document.createElementNS(SVG, 'path'); p.setAttribute('class', `mi-line ${f.key}`); svg.appendChild(p)
          const cap = document.createElement('div'); cap.className = 'mi-cap'
          const lab = document.createElement('span'); lab.textContent = f.label
          const val = document.createElement('b'); cap.append(lab, val)
          cell.append(svg, cap); grid.appendChild(cell)
          paths[f.key] = p; vals[f.key] = val
        }
        row.appendChild(grid); this.root.appendChild(row)
        r = { paths, vals }; this.rows.set(n, r)
      }
      const s = h.series.get(n)!
      for (const f of FIELDS) {
        const v = s.map((x) => x[f.key])
        r.paths[f.key].setAttribute('d', sparkPath(v, 100, 26, f.key === 'amps' ? 0 : undefined))
        const last = v[v.length - 1]
        r.vals[f.key].textContent = last === undefined ? '-' : `${last.toFixed(f.digits)} ${f.unit}`
      }
    }
    for (const [n, r] of this.rows) if (!names.includes(n)) { r.paths.position.closest('.mi-row')?.remove(); this.rows.delete(n) }
  }
}
