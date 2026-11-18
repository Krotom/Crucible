// Remembers the choices made in the side panels (game, robot mode, host, seed, ...) between runs, in the browser's local storage.
// Storage can be missing or blocked: then everything simply starts from the defaults.
const KEY = 'crucible-settings'
type Saved = Record<string, string | boolean>

function read(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return v && typeof v === 'object' ? (v as Saved) : {}
  } catch { return {} }
}

function write(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* not remembered */ }
}

/** Restores each control's saved value (a select only when the saved option still exists) and saves it again whenever the user changes it. */
export function bindSettings(ids: string[]): void {
  const saved = read()
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
    if (!el) continue
    const isCheck = el instanceof HTMLInputElement && el.type === 'checkbox'
    const v = saved[id]
    if (isCheck && typeof v === 'boolean') el.checked = v
    else if (!isCheck && typeof v === 'string') {
      if (el instanceof HTMLSelectElement) { if ([...el.options].some((o) => o.value === v)) el.value = v } else el.value = v
    }
    el.addEventListener(isCheck || el instanceof HTMLSelectElement ? 'change' : 'input', () => {
      const now = read()
      now[id] = isCheck ? (el as HTMLInputElement).checked : el.value
      write(now)
    })
  }
}
