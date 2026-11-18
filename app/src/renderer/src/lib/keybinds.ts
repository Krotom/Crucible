// Keyboard driving keys the user can change. A binding is a KeyboardEvent.code ("KeyW"), so it does not depend on the keyboard layout.
// Keys that already do something else (the shortcuts) cannot be bound, and a key can drive only one thing.
import { SHORTCUTS } from './shortcuts'

export type DriveAction = 'forward' | 'back' | 'left' | 'right' | 'rotateLeft' | 'rotateRight' | 'buttonA' | 'buttonB' | 'leftTrigger' | 'rightTrigger'

export const DRIVE_ACTIONS: { id: DriveAction; label: string; hint: string }[] = [
  { id: 'forward', label: 'Forward', hint: 'left stick up' }, { id: 'back', label: 'Back', hint: 'left stick down' },
  { id: 'left', label: 'Strafe left', hint: 'left stick left' }, { id: 'right', label: 'Strafe right', hint: 'left stick right' },
  { id: 'rotateLeft', label: 'Rotate left', hint: 'right stick left' }, { id: 'rotateRight', label: 'Rotate right', hint: 'right stick right' },
  { id: 'buttonA', label: 'A button', hint: 'intake' }, { id: 'buttonB', label: 'B button', hint: 'idle' },
  { id: 'leftTrigger', label: 'Left trigger', hint: 'shoot on the move' }, { id: 'rightTrigger', label: 'Right trigger', hint: 'shoot' },
]

export type Bindings = Record<DriveAction, string>

export const DEFAULT_KEYS: Bindings = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', rotateLeft: 'KeyQ', rotateRight: 'KeyE', buttonA: 'KeyJ', buttonB: 'KeyK', leftTrigger: 'KeyH', rightTrigger: 'KeyL',
}

const STORE = 'crucible-keys'

/** The KeyboardEvent.code a shortcut key name is typed with (layout-independent for letters and digits). */
function codeOfShortcutKey(key: string): string | null {
  const k = key.replace(/^ctrl\+|^shift\+/g, '')
  if (key.startsWith('ctrl+')) return null // Ctrl combinations never clash with plain driving keys
  if (k === ' ') return 'Space'
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`
  if (/^[0-9]$/.test(k)) return `Digit${k}`
  if (k === '.') return 'Period'
  if (k === '?') return 'Slash'
  if (k.startsWith('arrow')) return `Arrow${k.slice(5).charAt(0).toUpperCase()}${k.slice(6)}`
  return null
}

/** Codes that run a shortcut: they cannot also drive. */
export function reservedCodes(): Set<string> {
  const out = new Set<string>(['Escape', 'Tab', 'Enter', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'ContextMenu'])
  for (const s of SHORTCUTS) { const c = codeOfShortcutKey(s.key); if (c) out.add(c) }
  return out
}

export type BindResult = { ok: true; bindings: Bindings } | { ok: false; error: string }

/** Binds `code` to `action`, or says why not: a shortcut key, a modifier, or a key another action already uses. */
export function bind(current: Bindings, action: DriveAction, code: string): BindResult {
  if (reservedCodes().has(code)) return { ok: false, error: `${codeLabel(code)} is used by a shortcut or cannot be bound: pick another key` }
  const taken = (Object.keys(current) as DriveAction[]).find((a) => a !== action && current[a] === code)
  if (taken) return { ok: false, error: `${codeLabel(code)} already drives "${DRIVE_ACTIONS.find((x) => x.id === taken)!.label}": rebind that first` }
  return { ok: true, bindings: { ...current, [action]: code } }
}

/** Saved bindings, repaired: unknown actions dropped, and anything that is no longer allowed (or doubled) falls back to the default. */
export function cleanBindings(raw: unknown): Bindings {
  const actions = Object.keys(DEFAULT_KEYS) as DriveAction[]
  const out: Partial<Bindings> = {}
  const used = new Set<string>()
  const reserved = reservedCodes()
  const saved = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // first the saved choices that are still allowed and not doubled
  for (const a of actions) {
    const v = saved[a]
    if (typeof v === 'string' && /^[A-Za-z0-9]+$/.test(v) && !reserved.has(v) && !used.has(v)) { out[a] = v; used.add(v) }
  }
  // then every other action gets its default if that is free, else any default nobody uses (there are as many defaults as actions)
  for (const a of actions) {
    if (out[a]) continue
    const pick = !used.has(DEFAULT_KEYS[a]) ? DEFAULT_KEYS[a] : Object.values(DEFAULT_KEYS).find((c) => !used.has(c))!
    out[a] = pick; used.add(pick)
  }
  return out as Bindings
}

export function loadBindings(): Bindings {
  try { return cleanBindings(JSON.parse(localStorage.getItem(STORE) ?? 'null')) } catch { return { ...DEFAULT_KEYS } }
}
export function saveBindings(b: Bindings): void {
  try { localStorage.setItem(STORE, JSON.stringify(b)) } catch { /* not remembered */ }
}

/** "KeyW" -> "W", "ArrowUp" -> "↑", "Numpad4" -> "Num 4". */
export function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Backslash: '\\' }
  if (arrows[code]) return arrows[code]
  const np = /^Numpad(\w+)$/.exec(code)
  return np ? `Num ${np[1]}` : code
}
