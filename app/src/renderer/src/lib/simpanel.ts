// The sim panel over the 3D view: a header that is always shown (phase, clock, score) and a body of labeled rows in groups.
// The header is a button that folds the body away (the choice is remembered). Rows are created once and only their text changes,
// so tooltips and scrolling survive the 60 Hz updates.
import type { PanelModel, Row } from './simmodel'

const KEY = 'crucible-simpanel-collapsed'

interface RowEl { el: HTMLElement; label: HTMLElement; value: HTMLElement }
interface SectionEl { el: HTMLElement; title: HTMLElement; rows: Map<string, RowEl> }

function storage(): Storage | null {
  try { return localStorage } catch { return null }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

/** Puts `el` at position `i` among the children of `parent` without touching it when it is already there. */
function place(parent: HTMLElement, el: HTMLElement, i: number): void {
  if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null)
}

export class SimPanel {
  private head: HTMLButtonElement
  private phase: HTMLElement
  private clock: HTMLElement
  private blue: HTMLElement
  private red: HTMLElement
  private body: HTMLElement
  private sections = new Map<string, SectionEl>()

  constructor(private root: HTMLElement) {
    this.head = root.querySelector('.simhud-head') as HTMLButtonElement
    this.phase = root.querySelector('.sh-phase') as HTMLElement
    this.clock = root.querySelector('.sh-clock') as HTMLElement
    this.blue = root.querySelector('.sh-blue') as HTMLElement
    this.red = root.querySelector('.sh-red') as HTMLElement
    this.body = root.querySelector('.simhud-body') as HTMLElement
    let collapsed = false
    try { collapsed = storage()?.getItem(KEY) === '1' } catch { /* not remembered */ }
    this.setCollapsed(collapsed)
    this.head.addEventListener('click', () => {
      const next = !this.collapsed
      this.setCollapsed(next)
      try { storage()?.setItem(KEY, next ? '1' : '0') } catch { /* not remembered */ }
    })
  }

  get collapsed(): boolean { return this.root.classList.contains('collapsed') }

  setCollapsed(on: boolean): void {
    this.root.classList.toggle('collapsed', on)
    this.head.setAttribute('aria-expanded', String(!on))
    this.head.title = on ? 'Show the simulation details' : 'Hide the simulation details'
  }

  /** Forgets everything shown (a new sim starts, or the sim stopped), so old numbers never flash before the first frame of the next one. */
  clear(): void {
    for (const s of this.sections.values()) s.el.remove()
    this.sections.clear()
    for (const el of [this.phase, this.clock, this.blue, this.red]) el.textContent = ''
  }

  update(m: PanelModel): void {
    setText(this.phase, m.phase)
    setText(this.clock, m.clock)
    setText(this.blue, String(m.blue))
    setText(this.red, String(m.red))
    if (this.collapsed) return // the body is not drawn while it is folded away

    const wanted = new Set(m.sections.map((s) => s.id))
    for (const [id, s] of this.sections) if (!wanted.has(id)) { s.el.remove(); this.sections.delete(id) }
    m.sections.forEach((sec, i) => {
      let se = this.sections.get(sec.id)
      if (!se) {
        const el = document.createElement('section')
        const t = document.createElement('h4')
        el.appendChild(t)
        se = { el, title: t, rows: new Map() }
        this.sections.set(sec.id, se)
      }
      setText(se.title, sec.title)
      place(this.body, se.el, i)
      const ids = new Set(sec.rows.map((r) => r.id))
      for (const [id, r] of se.rows) if (!ids.has(id)) { r.el.remove(); se.rows.delete(id) }
      sec.rows.forEach((row, j) => this.updateRow(se!, row, j))
    })
  }

  private updateRow(se: SectionEl, row: Row, index: number): void {
    let re = se.rows.get(row.id)
    if (!re) {
      const el = document.createElement('div')
      el.className = 'kv'
      const label = document.createElement('span')
      label.className = 'k'
      const value = document.createElement('span')
      value.className = 'v'
      el.append(label, value)
      re = { el, label, value }
      se.rows.set(row.id, re)
    }
    setText(re.label, row.label)
    setText(re.value, row.value)
    const cls = row.tone ? `v ${row.tone}` : 'v'
    if (re.value.className !== cls) re.value.className = cls
    const hint = row.hint ?? ''
    if (re.el.title !== hint) re.el.title = hint
    place(se.el, re.el, index + 1) // child 0 is the group title
  }
}
