// The Tune tab: sliders for the physical values (live where the engine allows it), floor presets, the calibration wizard and the
// list of which robot values are measured and which are still guesses.
import CalWorker from '../../../calibration/worker?worker'
import type { CalIn, CalOut, CalResult } from '../../../calibration/worker'
import { applyTune, changedKeys, cleanTune, defaultTune, FLOOR_PRESETS, TUNE_DEFS, type TuneParams } from '../../../engine/tuning'
import { OFFSEASON } from '../../../robots/offseason'
import robotYaml from '../../../../robots/offseason/robot.yaml?raw'
import { parseParamNotes, summarize, type ParamNote } from './guesses'

const KEY = 'crucible-tune'
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function load(): TuneParams {
  try { return cleanTune(JSON.parse(localStorage.getItem(KEY) ?? '{}')) } catch { return {} }
}
function save(p: TuneParams): void { try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* not remembered */ } }

export interface TuneHooks {
  /** send the values that changed to the running sim (null when no sim runs) */
  live: (p: TuneParams) => void
  notify: (text: string) => void
  saveText: (name: string, text: string, mime: string) => Promise<void>
}

export class TuneUI {
  /** the robot definition's own values (also read by the page's checks) */
  readonly defaults = defaultTune({ drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact })
  private values: Required<TuneParams> = { ...this.defaults }
  private inputs = new Map<keyof TuneParams, { range: HTMLInputElement; num: HTMLInputElement; row: HTMLElement; badge: HTMLElement }>()
  private cal: Worker | null = null
  private last: CalResult | null = null

  constructor(private hooks: TuneHooks) {
    Object.assign(this.values, load())
    this.buildSliders()
    this.buildFloors()
    this.buildCalibration()
    this.buildGuesses()
    $('tune-reset').addEventListener('click', () => { for (const d of TUNE_DEFS) this.set(d.key, this.defaults[d.key], true); this.hooks.notify('Physics values back to the robot definition') })
    this.refresh()
  }

  /** The values that differ from the definition (what a new sim starts with). */
  params(): TuneParams {
    const out: TuneParams = {}
    for (const k of changedKeys(this.values, this.defaults)) out[k] = this.values[k]
    return out
  }

  private set(key: keyof TuneParams, v: number, push: boolean): void {
    const d = TUNE_DEFS.find((x) => x.key === key)!
    this.values[key] = Math.min(d.max, Math.max(d.min, v))
    save(this.params())
    this.refresh()
    if (push) this.hooks.live({ [key]: this.values[key] })
  }

  private buildSliders(): void {
    const box = $('tune-sliders')
    for (const d of TUNE_DEFS) {
      const row = el('div', 'tune-row')
      row.title = d.hint
      const head = el('div', 'tune-head')
      const label = el('span', 'tune-label', d.label)
      const badge = el('span', 'tune-badge', d.live ? 'live' : 'next reset')
      const def = el('button', 'tune-def', 'default')
      def.type = 'button'
      def.title = 'Back to the robot definition value'
      def.addEventListener('click', () => this.set(d.key, this.defaults[d.key], true))
      head.append(label, badge, el('span', 'grow'), def)
      const line = el('div', 'tune-line')
      const range = el('input')
      range.type = 'range'; range.id = `tune-${d.key}`; range.min = String(d.min); range.max = String(d.max); range.step = String(d.step)
      const num = el('input', 'tune-num')
      num.type = 'number'; num.id = `tune-${d.key}-n`; num.min = String(d.min); num.max = String(d.max); num.step = String(d.step)
      range.addEventListener('input', () => this.set(d.key, Number(range.value), true))
      num.addEventListener('change', () => { if (Number.isFinite(num.valueAsNumber)) this.set(d.key, num.valueAsNumber, true); else this.refresh() })
      line.append(range, num, el('span', 'tune-unit', d.unit))
      row.append(head, line)
      box.appendChild(row)
      this.inputs.set(d.key, { range, num, row, badge })
    }
  }

  private buildFloors(): void {
    const sel = $<HTMLSelectElement>('tune-floor')
    sel.append(new Option('custom', ''))
    for (const p of FLOOR_PRESETS) sel.append(new Option(`${p.label} (${p.mu})`, p.id))
    sel.addEventListener('change', () => {
      const p = FLOOR_PRESETS.find((x) => x.id === sel.value)
      if (p) this.set('mu', p.mu, true)
    })
  }

  /** Draws the sliders, the floor box and the tab marker from the current values. */
  refresh(): void {
    for (const d of TUNE_DEFS) {
      const i = this.inputs.get(d.key)!
      const v = this.values[d.key]
      i.range.value = String(v)
      if (document.activeElement !== i.num) i.num.value = String(Math.round(v * 1000) / 1000)
      const changed = Math.abs(v - this.defaults[d.key]) > 1e-9
      i.row.classList.toggle('changed', changed)
      ;(i.row.querySelector('.tune-def') as HTMLButtonElement).textContent = `default ${Math.round(this.defaults[d.key] * 1000) / 1000}`
    }
    const preset = FLOOR_PRESETS.find((p) => Math.abs(p.mu - this.values.mu) < 1e-9)
    $<HTMLSelectElement>('tune-floor').value = preset?.id ?? ''
    const n = Object.keys(this.params()).length
    document.querySelector('.tab[data-tab=tune]')?.classList.toggle('tuned', n > 0)
    $('tune-note').textContent = n === 0 ? 'Using the robot definition as it is.' : `${n} value${n === 1 ? ' differs' : 's differ'} from the robot definition (the Tune tab is marked). New sims start with them.`
  }

  /** Puts fitted values into the sliders and the running sim (calibration "Apply"). */
  apply(values: Record<string, number>): void {
    const p = cleanTune(values)
    for (const [k, v] of Object.entries(p)) this.set(k as keyof TuneParams, v as number, false)
    this.hooks.live(p)
  }

  // ---------------------------------------------------------------- calibration

  private worker(): Worker {
    if (!this.cal) {
      const w = new CalWorker()
      w.onmessage = (ev: MessageEvent<CalOut>) => this.onCal(ev.data)
      w.onerror = (e) => this.fail(e.message)
      this.cal = w
    }
    return this.cal
  }

  private send(m: CalIn): void { this.worker().postMessage(m) }

  private buildCalibration(): void {
    const kind = $<HTMLSelectElement>('cal-kind')
    const drive = (): void => { $('cal-drive-opts').hidden = kind.value !== 'drive' }
    kind.addEventListener('change', drive); drive()
    $('cal-open').addEventListener('click', () => { $<HTMLInputElement>('cal-file').value = ''; $<HTMLInputElement>('cal-file').click() })
    $<HTMLInputElement>('cal-file').addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f) $<HTMLTextAreaElement>('cal-csv').value = await f.text()
    })
    $('cal-example').addEventListener('click', () => this.send({ type: 'example', kind: kind.value as 'shots' | 'drive' }))
    $('cal-fit').addEventListener('click', () => {
      const csv = $<HTMLTextAreaElement>('cal-csv').value
      if (csv.trim() === '') { this.fail('Paste measured data, open a CSV file, or press Example first'); return }
      $('cal-fit').textContent = 'Fitting…'
      ;($('cal-fit') as HTMLButtonElement).disabled = true
      $('cal-out').textContent = ''
      this.send({ type: 'fit', kind: kind.value as 'shots' | 'drive', csv, volts: Number($<HTMLInputElement>('cal-volts').value) || 12, fitMass: $<HTMLInputElement>('cal-mass').checked })
    })
  }

  private done(): void { $('cal-fit').textContent = 'Fit'; ;($('cal-fit') as HTMLButtonElement).disabled = false }

  private fail(message: string): void {
    this.done()
    const out = $('cal-out')
    out.textContent = ''
    out.appendChild(el('div', 'cal-error', message))
  }

  private onCal(m: CalOut): void {
    if (m.type === 'error') { this.fail(m.message); return }
    if (m.type === 'example') { $<HTMLTextAreaElement>('cal-csv').value = m.csv; this.hooks.notify('Example data loaded: press Fit'); return }
    this.done()
    this.last = m.result
    this.showResult(m.result)
  }

  private showResult(r: CalResult): void {
    const out = $('cal-out')
    out.textContent = ''
    const better = r.after < r.before
    out.appendChild(el('div', better ? 'cal-sum good' : 'cal-sum', `Error ${r.before.toFixed(3)} → ${r.after.toFixed(3)} ${r.unit} (rms), ${r.evaluations} simulations`))
    const vals = el('div', 'cal-values')
    for (const [k, v] of Object.entries(r.values)) {
      const d = TUNE_DEFS.find((x) => x.key === k)
      const chip = el('span', 'cal-chip', `${d?.label ?? k} ${v.toFixed(3)}`)
      if (d) chip.title = `The definition has ${this.defaults[d.key]}`
      vals.appendChild(chip)
    }
    out.appendChild(vals)
    for (const n of r.notes) out.appendChild(el('div', 'cal-note', `Check: ${n}`))
    const table = el('table', 'an-table cal-table')
    const head = el('tr')
    for (const c of r.columns) head.appendChild(el('th', undefined, c))
    table.appendChild(head)
    for (const row of r.rows.slice(0, 14)) {
      const tr = el('tr')
      for (const v of row) tr.appendChild(el('td', undefined, v === null ? '-' : v.toFixed(2)))
      table.appendChild(tr)
    }
    out.appendChild(table)
    if (r.rows.length > 14) out.appendChild(el('div', 'dimtext', `${r.rows.length - 14} more rows in the report`))
    const btns = el('div', 'btnrow')
    const apply = el('button', 'wide primary', 'Apply to the sim'); apply.id = 'cal-apply'
    apply.title = 'Put the fitted values into the sliders (and the running sim)'
    apply.addEventListener('click', () => { this.apply(r.values); this.hooks.notify('Fitted values applied: see the sliders above') })
    const copy = el('button', undefined, 'Copy yaml'); copy.id = 'cal-copy'
    copy.title = 'Copy the lines to put into robots/offseason/robot.yaml'
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.yaml + '\n'); this.hooks.notify('Copied the robot.yaml lines') } catch { this.hooks.notify('Could not copy') } })
    const rep = el('button', undefined, 'Report…'); rep.id = 'cal-report'
    rep.addEventListener('click', () => { void this.hooks.saveText(`balta-crucible-calibration-${r.kind}.html`, r.html, 'text/html') })
    btns.append(apply, copy, rep)
    out.appendChild(btns)
    out.appendChild(el('pre', 'cal-yaml', r.yaml))
  }

  get lastResult(): CalResult | null { return this.last }

  // ---------------------------------------------------------------- what is measured

  private buildGuesses(): void {
    const notes = parseParamNotes(robotYaml)
    const sum = summarize(notes)
    $('guess-sum').textContent = `${sum.guesses} of ${sum.total} annotated values are still guesses (${sum.byTag.CODE} from the robot code, ${sum.byTag.CAD} from CAD, ${sum.byTag.FIT} fitted).`
    const list = $('guess-list')
    const filter = $<HTMLSelectElement>('guess-filter')
    const draw = (): void => {
      list.textContent = ''
      const shown = notes.filter((n: ParamNote) => filter.value === 'all' || n.tag === 'GUESS' || n.tag === 'ASSUMED')
      for (const n of shown) {
        const row = el('div', 'guess-row')
        row.title = n.note
        row.append(el('span', `badge ${n.tag.toLowerCase()}`, n.tag), el('span', 'guess-path', n.path), el('span', 'guess-val', n.value.length > 22 ? `${n.value.slice(0, 21)}…` : n.value))
        list.appendChild(row)
      }
      if (shown.length === 0) list.appendChild(el('div', 'dimtext', 'Nothing to show.'))
    }
    filter.addEventListener('change', draw)
    draw()
  }
}

/** The definition with the tune laid over it: what the next sim will use. Exposed for the page's checks. */
export function effectiveDefinition(p: TuneParams): ReturnType<typeof applyTune> extends infer T ? T : never {
  return applyTune({ drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact }, p) as never
}
