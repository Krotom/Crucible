// The application chrome around the 3D view: tabs, theme, About, the splash screen and the screenshot / video buttons.
import { saveBlob, screenshot, timestampName, VideoRecorder, type Saver } from './capture'
import { keyLabel, SHORTCUTS } from './shortcuts'

declare const __APP_VERSION__: string

export interface ChromeOptions {
  canvas: HTMLCanvasElement
  render: () => void
  notify: (text: string) => void
  host?: Saver
  /** the score and timer to burn into screenshots and videos, or null for none */
  banner?: () => { left: string; mid: string; right: string } | null
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function storage(): Storage | null {
  try { return localStorage } catch { return null }
}

let showTabImpl: (name: string) => void = () => {}
/** Switches the side panel to a tab ('session', 'robot' or 'topics'). */
export function showTab(name: string): void { showTabImpl(name) }

export function setupTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')]
  const show = (name: string): void => {
    for (const t of tabs) {
      const on = t.dataset.tab === name
      t.classList.toggle('on', on)
      t.setAttribute('aria-selected', String(on))
      $(`tab-${t.dataset.tab}`).hidden = !on
    }
    document.querySelector('.shell')?.classList.toggle('wide', name === 'robot' || name === 'analysis' || name === 'tune') // wider sidebar for the log and the charts
  }
  showTabImpl = show
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab!))
}

/** The keyboard shortcut sheet, built from the same table that runs the shortcuts. */
export function setupShortcutsDialog(): { open: () => void } {
  const dlg = $<HTMLDialogElement>('shortcuts')
  const list = $('shortcut-list')
  for (const group of ['Simulation', 'View', 'Log', 'Help'] as const) {
    const h = document.createElement('h4')
    h.textContent = group
    list.appendChild(h)
    for (const sc of SHORTCUTS.filter((x) => x.group === group)) {
      const row = document.createElement('div')
      row.className = 'sc'
      const label = document.createElement('span')
      label.textContent = sc.label
      const key = document.createElement('kbd')
      key.textContent = keyLabel(sc.key)
      row.append(label, key)
      list.appendChild(row)
    }
  }
  const open = (): void => { if (!dlg.open) dlg.showModal() }
  $('help-btn').addEventListener('click', open)
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  return { open }
}

export function setupTheme(): void {
  const btn = $('theme-btn')
  const paint = (): void => {
    const dark = document.documentElement.dataset.theme !== 'light'
    btn.querySelector('use')!.setAttribute('href', dark ? '#i-sun' : '#i-moon')
    btn.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme'
  }
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    try { storage()?.setItem('crucible-theme', next) } catch { /* not saved */ }
    paint()
  })
  paint()
}

export function appVersion(): string { return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' }

export function setupAbout(): void {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
  $('app-version').textContent = `v${version}`
  $('about-version').textContent = version
  const dlg = $<HTMLDialogElement>('about')
  $('about-btn').addEventListener('click', () => dlg.showModal())
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
}

/** Fades the splash out once the app has had a moment to draw (about a second, shorter when the user prefers less motion). */
export function dismissSplash(): void {
  const el = $('splash')
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 600) }, reduced ? 100 : 1100)
}

export function setupCapture(o: ChromeOptions): void {
  const rec = new VideoRecorder()
  const shotBtn = $('shot-btn')
  const recBtn = $('rec-btn')
  const recTime = $('rec-time')
  let timer: ReturnType<typeof setInterval> | null = null

  shotBtn.addEventListener('click', async () => {
    try {
      const blob = await screenshot(o.canvas, o.render, o.banner)
      const where = await saveBlob(timestampName('balta-crucible', 'png'), blob, o.host)
      if (where) o.notify(`Screenshot saved: ${where}`)
    } catch (e) { o.notify(`Screenshot failed: ${(e as Error).message}`) }
  })

  const paint = (): void => {
    recBtn.classList.toggle('on', rec.active)
    recBtn.querySelector('use')!.setAttribute('href', rec.active ? '#i-stop' : '#i-rec')
    recBtn.title = rec.active ? 'Stop recording and save the video' : 'Record the 3D view to a WebM video'
    recTime.hidden = !rec.active
  }
  recBtn.addEventListener('click', async () => {
    if (!rec.active) {
      try { rec.start(o.canvas, 30, 8_000_000, o.banner) } catch (e) { o.notify(`Cannot record: ${(e as Error).message}`); return }
      timer = setInterval(() => { const s = Math.floor(rec.seconds); recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }, 250)
      recTime.textContent = '0:00'
      paint()
      return
    }
    if (timer) clearInterval(timer)
    const blob = await rec.stop()
    paint()
    try {
      const where = await saveBlob(timestampName('balta-crucible', 'webm'), blob, o.host)
      if (where) o.notify(`Video saved: ${where}`)
    } catch (e) { o.notify(`Saving the video failed: ${(e as Error).message}`) }
  })
}
