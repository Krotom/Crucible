// The log widget of the Robot tab: the robot process's (Gradle's) output, line by line.
// Keeps the last MAX_LINES lines, colors them by severity, filters, follows the newest line and can copy or save what is shown.

export type LogLevel = 'error' | 'warn' | 'ok' | 'info' | 'sys'

export const MAX_LINES = 5000

/** Removes terminal color / cursor codes (ESC [ ... letter) and stray carriage returns: the log shows plain text, colored by severity instead. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[@-Z\\-_]/g, '').replace(/\r/g, '')
}

/** Severity of one line of Gradle / robot output, for coloring. */
export function classifyLine(line: string): LogLevel {
  if (/^BUILD SUCCESSFUL/.test(line)) return 'ok'
  if (/^BUILD FAILED|^FAILURE:|^\* What went wrong|\bERROR\b|Exception\b|^\s+at [\w$.]+\(|Could not |launch failed/.test(line)) return 'error'
  if (/\bWARN(ING)?\b|^warning:|deprecated/i.test(line)) return 'warn'
  return 'info'
}

export type LogSource = 'build' | 'robot' | 'app'

/** Splits output into what the build printed and what the robot program printed: the robot starts at `> Task :simulateJava` / its startup banner. */
export class SourceTracker {
  private running = false
  reset(): void { this.running = false }
  next(line: string): 'build' | 'robot' {
    if (this.running) return 'robot'
    if (/^> Task :simulateJava\b/.test(line) || /Robot program starting/i.test(line)) this.running = true
    return 'build'
  }
}

export interface SourceRef { start: number; end: number; file: string; line: number }

/** `(Robot.java:42)` in a stack frame, or `src/.../Robot.java:42` in a compiler message: where in the text, which file name, which line. */
export function findSourceRefs(text: string): SourceRef[] {
  const out: SourceRef[] = []
  const frame = /\(([\w$]+\.(?:java|kt)):(\d+)\)/g
  for (let m = frame.exec(text); m; m = frame.exec(text)) out.push({ start: m.index + 1, end: m.index + m[0].length - 1, file: m[1], line: Number(m[2]) })
  if (out.length > 0) return out
  const path = /(?:[A-Za-z]:)?[\w.$\\/-]*?([\w$]+\.(?:java|kt)):(\d+)/g
  for (let m = path.exec(text); m; m = path.exec(text)) out.push({ start: m.index, end: m.index + m[0].length, file: m[1], line: Number(m[2]) })
  return out
}

interface Entry { text: string; level: LogLevel; src: LogSource; el: HTMLElement | null }

export class LogView {
  private entries: Entry[] = []
  private filter = ''
  private follow = true
  private pending = false
  /** Which severities are shown. OK lines (BUILD SUCCESSFUL) and the app's own lines always are. */
  private levelOn: Record<LogLevel, boolean> = { error: true, warn: true, info: true, ok: true, sys: true }
  private cursor: Entry | null = null
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private srcFilter: 'all' | 'build' | 'robot' = 'all'
  private opener: ((file: string, line: number) => void) | null = null
  private flashEl: HTMLElement | null = null

  constructor(
    private box: HTMLElement,
    private ui: {
      count: HTMLElement; filter: HTMLInputElement; follow: HTMLInputElement; copy: HTMLButtonElement; save: HTMLButtonElement; clear: HTMLButtonElement
      levels: { error: HTMLInputElement; warn: HTMLInputElement; info: HTMLInputElement }
      errCount: HTMLElement; errPrev: HTMLButtonElement; errNext: HTMLButtonElement
      sources: HTMLElement
    },
    private notify: (text: string) => void,
  ) {
    for (const k of ['error', 'warn', 'info'] as const) ui.levels[k].addEventListener('change', () => this.syncLevels())
    for (const b of ui.sources.querySelectorAll<HTMLButtonElement>('button[data-src]')) b.addEventListener('click', () => this.setSource(b.dataset.src as 'all' | 'build' | 'robot'))
    box.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a.src-link') as HTMLAnchorElement | null
      if (!a || !this.opener) return
      e.preventDefault()
      this.opener(a.dataset.file!, Number(a.dataset.line))
    })
    ui.errPrev.addEventListener('click', () => this.jumpError(-1))
    ui.errNext.addEventListener('click', () => this.jumpError(1))
    ui.filter.addEventListener('input', () => { this.filter = ui.filter.value.trim().toLowerCase(); this.rebuild() })
    ui.follow.addEventListener('change', () => { this.follow = ui.follow.checked; if (this.follow) this.scrollEnd() })
    ui.clear.addEventListener('click', () => this.clear())
    ui.copy.addEventListener('click', () => { void this.copy() })
    ui.save.addEventListener('click', () => this.save())
    // scrolling up by hand stops following; scrolling back to the bottom resumes it
    box.addEventListener('scroll', () => {
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24
      if (atEnd !== this.follow) { this.follow = atEnd; ui.follow.checked = atEnd }
    })
    this.updateCount()
  }

  /** Adds one line (output of the robot process). */
  add(raw: string, level?: LogLevel, src: LogSource = 'build'): void {
    const text = stripAnsi(raw)
    this.entries.push({ text, level: level ?? classifyLine(text), src, el: null })
    if (this.entries.length > MAX_LINES) {
      const drop = this.entries.splice(0, this.entries.length - MAX_LINES)
      for (const d of drop) d.el?.remove()
    }
    this.schedule()
  }

  /** A line the app itself writes (the command it runs, how the process ended). */
  system(text: string): void { this.add(text, 'sys', 'app') }

  /** Lets stack-trace and compiler-message file references be clicked (desktop app: opens the file in the editor). */
  setSourceOpener(fn: ((file: string, line: number) => void) | null): void { this.opener = fn; this.rebuild() }

  setSource(src: 'all' | 'build' | 'robot'): void {
    this.srcFilter = src
    for (const b of this.ui.sources.querySelectorAll<HTMLButtonElement>('button[data-src]')) {
      const on = b.dataset.src === src
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
    }
    this.rebuild()
  }

  /** Puts the text of a past run into the log, under a heading, split into build and robot output like live output. */
  addHistory(name: string, text: string): void {
    this.add(`[— past run ${name} —]`, 'sys', 'app')
    const t = new SourceTracker()
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      if (line.startsWith('# ')) this.add(line, 'sys', 'app')
      else this.add(line, undefined, t.next(line))
    }
    this.add('[— end of past run —]', 'sys', 'app')
  }

  /** Reads the severity checkboxes again (after the page restored them) and redraws. */
  syncLevels(): void {
    for (const k of ['error', 'warn', 'info'] as const) this.levelOn[k] = this.ui.levels[k].checked
    this.rebuild()
  }

  /** Moves to the next (1) or previous (-1) error: the first line of each run of error lines, wrapping around. */
  jumpError(dir: 1 | -1): void {
    const blocks = this.errorBlocks().filter((e) => e.el)
    if (blocks.length === 0) { this.notify('No errors in the log'); return }
    const at = this.cursor ? blocks.indexOf(this.cursor) : -1
    const next = at < 0 ? (dir === 1 ? 0 : blocks.length - 1) : (at + dir + blocks.length) % blocks.length
    const e = blocks[next]
    this.cursor = e
    this.follow = false
    this.ui.follow.checked = false
    e.el!.scrollIntoView({ block: 'center' })
    // one highlight at a time: an older jump's timer must not cut the new one short
    if (this.flashTimer !== null) clearTimeout(this.flashTimer)
    this.flashEl?.classList.remove('flash')
    this.flashEl = e.el
    e.el!.classList.add('flash')
    this.flashTimer = setTimeout(() => { this.flashEl?.classList.remove('flash'); this.flashEl = null; this.flashTimer = null }, 1200)
    this.notify(`Error ${next + 1} of ${blocks.length}`)
  }

  /** The first line of every run of consecutive error lines (a message and its stack trace count once). */
  errorBlocks(): Entry[] {
    const out: Entry[] = []
    this.entries.forEach((e, i) => { if (e.level === 'error' && this.entries[i - 1]?.level !== 'error') out.push(e) })
    return out
  }

  clear(): void {
    this.cursor = null
    this.entries = []
    this.box.textContent = ''
    this.updateCount()
  }

  get lineCount(): number { return this.entries.length }

  /** The lines that pass the filter, as plain text. */
  shownText(): string { return this.shown().map((e) => e.text).join('\n') }

  private matches(e: Entry): boolean {
    return this.levelOn[e.level] && (this.srcFilter === 'all' || e.src === 'app' || e.src === this.srcFilter) && (!this.filter || e.text.toLowerCase().includes(this.filter))
  }

  private shown(): Entry[] { return this.entries.filter((e) => this.matches(e)) }

  // many lines arrive at once while Gradle builds: draw them once per frame
  private schedule(): void {
    if (this.pending) return
    this.pending = true
    requestAnimationFrame(() => { this.pending = false; this.flush() })
  }

  private flush(): void {
    const frag = document.createDocumentFragment()
    for (const e of this.entries) {
      if (e.el || !this.matches(e)) continue
      e.el = this.row(e)
      frag.appendChild(e.el)
    }
    this.box.appendChild(frag)
    this.updateCount()
    if (this.follow) this.scrollEnd()
  }

  private rebuild(): void {
    this.box.textContent = ''
    for (const e of this.entries) e.el = null
    this.flush()
  }

  private row(e: Entry): HTMLElement {
    const el = document.createElement('div')
    el.className = `ln ${e.level}`
    const refs = this.opener ? findSourceRefs(e.text) : []
    if (refs.length === 0) { el.textContent = e.text; return el }
    let at = 0
    for (const r of refs) {
      if (r.start > at) el.append(document.createTextNode(e.text.slice(at, r.start)))
      const a = document.createElement('a')
      a.className = 'src-link'
      a.href = '#'
      a.dataset.file = r.file
      a.dataset.line = String(r.line)
      a.title = `Open ${r.file} at line ${r.line}`
      a.textContent = e.text.slice(r.start, r.end)
      el.append(a)
      at = r.end
    }
    if (at < e.text.length) el.append(document.createTextNode(e.text.slice(at)))
    return el
  }

  private scrollEnd(): void { this.box.scrollTop = this.box.scrollHeight }

  private updateCount(): void {
    const hidden = this.filter !== '' || this.srcFilter !== 'all' || !this.levelOn.error || !this.levelOn.warn || !this.levelOn.info
    const shown = hidden ? this.shown().length : this.entries.length
    this.ui.count.textContent = hidden ? `${shown} of ${this.entries.length} lines` : `${this.entries.length} line${this.entries.length === 1 ? '' : 's'}`
    const errors = this.errorBlocks().length
    this.ui.errCount.textContent = `${errors} error${errors === 1 ? '' : 's'}`
    this.ui.errCount.classList.toggle('has', errors > 0)
    this.ui.errPrev.disabled = this.ui.errNext.disabled = errors === 0
  }

  private async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.shownText()); this.notify(`Copied ${this.shown().length} log lines`) }
    catch { this.notify('Could not copy the log') }
  }

  private save(): void {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`${this.shownText()}\n`], { type: 'text/plain' }))
    a.download = `crucible-robot-log-${stamp}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
}
