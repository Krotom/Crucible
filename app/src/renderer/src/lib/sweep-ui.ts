// The seed sweep card: runs the scripted match for many seeds in a worker and shows the spread of the results.
import SweepWorker from '../../../engine/sweep-worker?worker'
import type { SweepOut } from '../../../engine/sweep-worker'
import { record, stats, type SweepRequest, type SweepRun } from '../../../engine/sweep'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const fmt = (v: number): string => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(1))

/** Mean, spread and range of both scores, who won how often, and every run. */
export function renderSweep(into: HTMLElement, runs: SweepRun[]): void {
  into.textContent = ''
  if (runs.length === 0) return
  const table = el('table', 'an-table')
  const head = el('tr')
  for (const t of ['', 'mean ± sd', 'median', 'min – max']) head.appendChild(el('th', undefined, t))
  table.appendChild(head)
  for (const [label, key, cls] of [['Blue', 'blue', 'blue'], ['Red', 'red', 'red']] as const) {
    const s = stats(runs.map((r) => r[key]))!
    const tr = el('tr')
    tr.append(el('td', cls, label), el('td', undefined, `${s.mean.toFixed(1)} ± ${s.sd.toFixed(1)}`), el('td', undefined, fmt(s.median)), el('td', undefined, `${fmt(s.min)} – ${fmt(s.max)}`))
    table.appendChild(tr)
  }
  into.appendChild(table)
  const rec = record(runs)
  into.appendChild(el('div', 'dimtext', `${runs.length} runs: blue won ${rec.blue}, red won ${rec.red}, ${rec.tie} tied · ${runs.reduce((a, r) => a + r.fouls, 0)} fouls in total`))
  const list = el('div', 'sw-list')
  for (const r of runs) {
    const row = el('div', 'sw-row')
    row.append(el('span', 'dimtext', `seed ${r.seed}`), el('b', 'blue', String(r.blue)), el('i', undefined, ':'), el('b', 'red', String(r.red)), el('span', 'dimtext', `${(r.wallMs / 1000).toFixed(1)} s`))
    list.appendChild(row)
  }
  into.appendChild(list)
}

export class SweepRunner {
  private worker: Worker | null = null
  runs: SweepRun[] = []

  get running(): boolean { return this.worker !== null }

  start(req: SweepRequest, onChange: (state: { runs: SweepRun[]; total: number; done: boolean; cancelled: boolean; error?: string }) => void): void {
    this.cancel()
    this.runs = []
    const w = new SweepWorker()
    this.worker = w
    w.onmessage = (ev: MessageEvent<SweepOut>) => {
      const m = ev.data
      if (m.type === 'run') { this.runs.push(m.run); onChange({ runs: this.runs, total: m.total, done: false, cancelled: false }) }
      else {
        w.terminate(); if (this.worker === w) this.worker = null
        onChange(m.type === 'done' ? { runs: this.runs, total: req.seeds.length, done: true, cancelled: m.cancelled } : { runs: this.runs, total: req.seeds.length, done: true, cancelled: false, error: m.message })
      }
    }
    w.onerror = (e) => { w.terminate(); if (this.worker === w) this.worker = null; onChange({ runs: this.runs, total: req.seeds.length, done: true, cancelled: false, error: e.message }) }
    w.postMessage({ type: 'start', req })
  }

  cancel(): void { this.worker?.postMessage({ type: 'cancel' }) }
}
void $
