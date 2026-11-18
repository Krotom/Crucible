// The DOM side of the quality-of-life features: toasts, the command palette, presets, preferences, recent files, the update check and "what's new".
// The logic they use (queue, ranking, preset storage, versions, translations) lives in small tested modules next to this one.
import { applyLanguage, type Lang } from './i18n'
import { rank, type Command } from './cmdpalette'
import { PresetStore, captureValues, type Values } from './presets'
import { ToastQueue, kindOf } from './toast'
import { CHANGELOG, entriesSince } from './versions'
import { setA11y, zoomFor, type A11y } from './a11y'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const store = (): Storage | null => { try { return localStorage } catch { return null } }
interface Host {
  pathOf?: (f: File) => string
  recentList?: () => Promise<{ path: string; name: string }[]>
  recentAdd?: (p: string) => Promise<boolean>
  recentForget?: (p: string) => Promise<void>
  recentRead?: (p: string) => Promise<{ name: string; data: ArrayBuffer } | null>
  checkUpdate?: () => Promise<{ status: string; latest?: string; url?: string; notes?: string; error?: string }>
  openExternal?: (u: string) => Promise<boolean>
  setZoom?: (f: number) => void
}
const host = (): Host => ((window as unknown as { crucibleHost?: Host }).crucibleHost ?? {})

// ---------------------------------------------------------------- toasts
export const toasts = new ToastQueue()
const toastActions = new Map<number, () => void>()

function drawToasts(): void {
  const box = $('toasts')
  const list = toasts.visible()
  box.textContent = ''
  for (const t of list) {
    const d = document.createElement('div')
    d.className = `toast ${t.kind}`
    d.dataset.id = String(t.id)
    d.textContent = t.text
    if (t.count > 1) { const n = document.createElement('span'); n.className = 'n'; n.textContent = `×${t.count}`; d.appendChild(n) }
    d.addEventListener('click', () => { toastActions.get(t.id)?.(); toasts.dismiss(t.id); toastActions.delete(t.id); drawToasts() })
    box.appendChild(d)
  }
}

/** Shows a toast. The older code only sets the status-bar text; `setupToasts` turns every such change into a toast too. */
export function toast(text: string, kind = kindOf(text), onClick?: () => void): void {
  const t = toasts.push(text, kind)
  if (t && onClick) toastActions.set(t.id, onClick)
  drawToasts()
}

export function setupToasts(): void {
  const notice = $('notice')
  new MutationObserver(() => { const t = notice.textContent ?? ''; if (t.trim()) toast(t) }).observe(notice, { childList: true, characterData: true, subtree: true })
  setInterval(() => { if ($('toasts').childElementCount > 0 || toasts.visible().length > 0) drawToasts() }, 500)
}

// ---------------------------------------------------------------- command palette
export function setupPalette(commands: () => Command[], run: (id: string) => void): { open: () => void } {
  const dlg = $<HTMLDialogElement>('palette')
  const input = $<HTMLInputElement>('palette-input')
  const list = $('palette-list')
  let shown: Command[] = []
  let sel = 0
  const paint = (): void => {
    shown = rank(commands(), input.value)
    sel = Math.min(sel, Math.max(0, shown.length - 1))
    list.textContent = ''
    if (shown.length === 0) { const e = document.createElement('div'); e.className = 'pal-empty'; e.textContent = 'No command matches'; list.appendChild(e); return }
    shown.forEach((c, i) => {
      const row = document.createElement('div')
      row.className = 'pal-item' + (i === sel ? ' on' : '')
      row.setAttribute('role', 'option'); row.dataset.id = c.id
      const g = document.createElement('span'); g.className = 'g'; g.textContent = c.group ?? ''
      const l = document.createElement('span'); l.className = 'l'; l.textContent = c.label
      row.append(g, l)
      if (c.hint) { const k = document.createElement('kbd'); k.textContent = c.hint; row.appendChild(k) }
      row.addEventListener('click', () => choose(c))
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paint() } })
      list.appendChild(row)
    })
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (c: Command): void => { dlg.close(); setTimeout(() => run(c.id), 0) }
  input.addEventListener('input', () => { sel = 0; paint() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); paint() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint() }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) choose(shown[sel]) }
  })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  const open = (): void => { if (dlg.open) return; input.value = ''; sel = 0; paint(); dlg.showModal(); input.focus() }
  return { open }
}

// ---------------------------------------------------------------- presets
/** The controls a preset remembers: the session set-up, not the view menu or the log filters. */
export const PRESET_IDS = ['game-select', 'sim-mode', 'opponent', 'alliance', 'start-x', 'start-y', 'start-yaw', 'step-dt', 'seed', 'bat-on', 'bat-open', 'bat-res', 'f-brown-on', 'f-brown', 'f-lat', 'f-noise', 'f-drop', 'vis-on', 'vis-noise', 'bp-launch', 'bp-capture', 'bp-score', 'bp-foul', 'bp-phase', 'bp-impact-on', 'bp-impact', 'bp-time-on', 'bp-time']

export function readControl(id: string): string | boolean | undefined {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  if (!el) return undefined
  return el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value
}
export function applyValues(v: Values): number {
  let n = 0
  for (const [id, val] of Object.entries(v)) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
    if (!el) continue
    if (el instanceof HTMLInputElement && el.type === 'checkbox') { if (typeof val !== 'boolean') continue; el.checked = val }
    else {
      if (typeof val !== 'string') continue
      if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === val)) continue // an option that no longer exists
      el.value = val
    }
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    n++
  }
  return n
}

export const presets = new PresetStore(store())
export function loadPreset(name: string): string {
  const p = presets.get(name)
  if (!p) return `No preset called "${name}"`
  const n = applyValues(p.values)
  return `Loaded preset "${p.name}" (${n} settings). Start or restart the sim to use it.`
}

export function setupPresets(notify: (t: string) => void): void {
  const sel = $<HTMLSelectElement>('preset-sel'), name = $<HTMLInputElement>('preset-name'), note = $('preset-note')
  const fill = (keep?: string): void => {
    const all = presets.list()
    sel.textContent = ''
    const first = document.createElement('option'); first.value = ''; first.textContent = all.length ? 'Choose a preset…' : 'No presets saved yet'; sel.appendChild(first)
    for (const p of all) { const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sel.appendChild(o) }
    if (keep && all.some((p) => p.name === keep)) sel.value = keep
  }
  fill()
  $('preset-save').addEventListener('click', () => {
    const err = presets.save(name.value, captureValues(PRESET_IDS, readControl))
    if (err) { note.textContent = err; return }
    const saved = presets.get(name.value)!.name
    note.textContent = `Saved "${saved}"`; notify(`Saved preset "${saved}"`); fill(saved); name.value = ''
  })
  $('preset-load').addEventListener('click', () => { if (!sel.value) { note.textContent = 'Choose a preset first'; return } const m = loadPreset(sel.value); note.textContent = m; notify(m) })
  $('preset-del').addEventListener('click', () => {
    if (!sel.value) { note.textContent = 'Choose a preset first'; return }
    const n = sel.value
    note.textContent = presets.delete(n) ? `Deleted "${n}"` : 'Could not delete it'; fill()
  })
  sel.addEventListener('change', () => { if (sel.value) name.value = sel.value })
}

// ---------------------------------------------------------------- preferences: language, colours, text size
const PREFS_KEY = 'crucible-prefs'
export interface Prefs extends A11y { lang: Lang }
export function readPrefs(): Prefs {
  try {
    const v = JSON.parse(store()?.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return { lang: v.lang === 'tr' ? 'tr' : 'en', colorblind: v.colorblind === true, large: v.large === true }
  } catch { return { lang: 'en', colorblind: false, large: false } }
}
let langObserver: MutationObserver | null = null
export function applyPrefs(p: Prefs): void {
  const root = document.documentElement
  root.lang = p.lang
  if (p.colorblind) root.dataset.cb = '1'; else delete root.dataset.cb
  setA11y(p)
  host().setZoom?.(zoomFor(p))
  langObserver?.disconnect(); langObserver = null
  applyLanguage(document.body, p.lang) // also puts the English back when the language is English
  if (p.lang === 'tr') {
    // text the app sets while it runs (Play / Pause, Start sim / Stop sim, ...) is translated as it appears
    langObserver = new MutationObserver((records) => {
      const roots = new Set<Element>()
      for (const r of records) {
        if (r.type === 'characterData') { const e = (r.target as Text).parentElement; if (e) roots.add(e) }
        else if (r.type === 'attributes') roots.add(r.target as Element)
        else for (const n of Array.from(r.addedNodes)) { const e = n instanceof Element ? n : n.parentElement; if (e) roots.add(e) }
      }
      langObserver?.disconnect()
      for (const e of roots) applyLanguage(e, 'tr')
      langObserver?.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['title', 'placeholder'] })
    })
    langObserver.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['title', 'placeholder'] })
  }
}

export function setupPrefs(): { open: () => void } {
  const dlg = $<HTMLDialogElement>('prefs')
  const lang = $<HTMLSelectElement>('pref-lang'), cb = $<HTMLInputElement>('pref-cb'), large = $<HTMLInputElement>('pref-large')
  const p = readPrefs()
  lang.value = p.lang; cb.checked = p.colorblind; large.checked = p.large
  applyPrefs(p)
  const change = (): void => {
    const now: Prefs = { lang: lang.value === 'tr' ? 'tr' : 'en', colorblind: cb.checked, large: large.checked }
    try { store()?.setItem(PREFS_KEY, JSON.stringify(now)) } catch { /* not remembered */ }
    applyPrefs(now)
  }
  for (const e of [lang, cb, large]) e.addEventListener('change', change)
  $('prefs-btn').addEventListener('click', () => { if (!dlg.open) dlg.showModal() })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  return { open: () => { if (!dlg.open) dlg.showModal() } }
}

// ---------------------------------------------------------------- recent files
export function setupRecent(open: (f: File, path?: string) => void, notify: (t: string) => void): { remember: (f: File, path?: string) => void } {
  const sel = $<HTMLSelectElement>('recent-files')
  const refresh = async (): Promise<void> => {
    const list = (await host().recentList?.()) ?? []
    sel.textContent = ''
    const first = document.createElement('option'); first.value = ''; first.textContent = 'Recent files…'; sel.appendChild(first)
    for (const f of list) { const o = document.createElement('option'); o.value = f.path; o.textContent = f.name; o.title = f.path; sel.appendChild(o) }
    sel.hidden = list.length === 0
  }
  sel.addEventListener('change', async () => {
    const path = sel.value
    if (!path) return
    sel.value = ''
    const r = await host().recentRead?.(path)
    if (!r) { await host().recentForget?.(path); notify('That file is not there any more: removed it from the list'); await refresh(); return }
    open(new File([r.data], r.name), path); sel.blur()
  })
  void refresh()
  return { remember: (f, known) => { const p = known || host().pathOf?.(f); if (p) void host().recentAdd?.(p).then(refresh) } }
}

// ---------------------------------------------------------------- update check and what's new
function showWhatsNew(version: string, lastSeen: string | null): void {
  const body = $('whatsnew-body')
  body.textContent = ''
  const entries = lastSeen ? entriesSince(lastSeen, version) : CHANGELOG.slice(0, 1)
  for (const r of entries.length ? entries : CHANGELOG.slice(0, 1)) {
    const h = document.createElement('h4'); h.textContent = `${r.version}: ${r.title}`
    const ul = document.createElement('ul')
    for (const it of r.items) { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li) }
    body.append(h, ul)
  }
  const dlg = $<HTMLDialogElement>('whatsnew')
  if (!dlg.open) dlg.showModal()
}

export function setupUpdates(version: string): void {
  const KEY = 'crucible-lastseen'
  let last: string | null = null
  try { last = store()?.getItem(KEY) ?? null } catch { /* first run */ }
  try { store()?.setItem(KEY, version) } catch { /* not remembered */ }
  // an updated app announces itself with a toast (not a dialog: it must never block the first click); a first run says nothing
  if (last && last !== version && entriesSince(last, version).length > 0) toast(`Updated to v${version}: click to see what's new`, 'info', () => showWhatsNew(version, last))
  $('whatsnew-btn').addEventListener('click', () => showWhatsNew(version, null))
  const status = $('update-status'), btn = $<HTMLButtonElement>('update-btn')
  btn.addEventListener('click', async () => {
    if (!host().checkUpdate) { status.textContent = 'Update checks are only available in the desktop app.'; return }
    btn.disabled = true; status.textContent = 'Checking…'
    const r = await host().checkUpdate!()
    btn.disabled = false
    status.textContent = ''
    if (r.status === 'newer') {
      status.append(`Version ${r.latest} is available (you have ${version}). `)
      if (r.url) { const a = document.createElement('a'); a.href = '#'; a.textContent = 'Open the release page'; a.addEventListener('click', (e) => { e.preventDefault(); void host().openExternal?.(r.url!) }); status.appendChild(a) }
    } else if (r.status === 'current') status.textContent = `You have the latest version (${version}).`
    else if (r.status === 'none') status.textContent = `No release has been published yet (this is ${version}).`
    else status.textContent = r.error ?? 'The check failed.'
  })
}
