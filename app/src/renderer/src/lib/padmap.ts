// Gamepad mapping: which physical button or axis stands for each control the robot sees (an Xbox controller on port 0), with inversion and
// a dead zone. The default is the standard mapping browsers give for Xbox-style pads.
export interface PadLike { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }

export type PadButton = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'Back' | 'Start' | 'L3' | 'R3'
export type PadAxisName = 'lx' | 'ly' | 'lt' | 'rt' | 'rx' | 'ry'
export interface AxisSource { kind: 'axis' | 'button'; index: number; invert: boolean }
export interface PadMap {
  buttons: Record<PadButton, number>
  axes: Record<PadAxisName, AxisSource>
  deadzone: number
}

export const PAD_BUTTONS: PadButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'Back', 'Start', 'L3', 'R3']
export const PAD_AXES: { id: PadAxisName; label: string }[] = [
  { id: 'lx', label: 'Left stick X' }, { id: 'ly', label: 'Left stick Y' }, { id: 'lt', label: 'Left trigger' }, { id: 'rt', label: 'Right trigger' }, { id: 'rx', label: 'Right stick X' }, { id: 'ry', label: 'Right stick Y' },
]

export const DEFAULT_PADMAP: PadMap = {
  buttons: { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, Back: 8, Start: 9, L3: 10, R3: 11 },
  axes: {
    lx: { kind: 'axis', index: 0, invert: false }, ly: { kind: 'axis', index: 1, invert: false },
    lt: { kind: 'button', index: 6, invert: false }, rt: { kind: 'button', index: 7, invert: false },
    rx: { kind: 'axis', index: 2, invert: false }, ry: { kind: 'axis', index: 3, invert: false },
  },
  deadzone: 0.06,
}

const STORE = 'crucible-padmap'
const idx = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 32 ? v : d)

/** Saved mapping, repaired: anything missing or out of range falls back to the default. */
export function cleanPadMap(raw: unknown): PadMap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { buttons?: Record<string, unknown>; axes?: Record<string, Partial<AxisSource>>; deadzone?: unknown }
  const out: PadMap = JSON.parse(JSON.stringify(DEFAULT_PADMAP))
  for (const b of PAD_BUTTONS) out.buttons[b] = idx(r.buttons?.[b], DEFAULT_PADMAP.buttons[b])
  for (const a of PAD_AXES) {
    const s = r.axes?.[a.id]
    out.axes[a.id] = { kind: s?.kind === 'button' || s?.kind === 'axis' ? s.kind : DEFAULT_PADMAP.axes[a.id].kind, index: idx(s?.index, DEFAULT_PADMAP.axes[a.id].index), invert: s?.invert === true }
  }
  out.deadzone = typeof r.deadzone === 'number' && Number.isFinite(r.deadzone) ? Math.min(0.4, Math.max(0, r.deadzone)) : DEFAULT_PADMAP.deadzone
  return out
}

export function loadPadMap(): PadMap {
  try { return cleanPadMap(JSON.parse(localStorage.getItem(STORE) ?? 'null')) } catch { return cleanPadMap(null) }
}
export function savePadMap(m: PadMap): void {
  try { localStorage.setItem(STORE, JSON.stringify(m)) } catch { /* not remembered */ }
}

/** One mapped control's value from a pad: stick axes get the dead zone and optional inversion, triggers read a button's analog value or an axis. */
export function readAxis(pad: PadLike, s: AxisSource, deadzone: number): number {
  let v = s.kind === 'axis' ? pad.axes[s.index] ?? 0 : pad.buttons[s.index]?.value ?? 0
  if (Math.abs(v) < deadzone) v = 0
  return s.invert ? 0 - v : v // 0 - v: an inverted axis at rest is 0, not -0
}

/** What the robot sees for this pad: the six axes, the ten buttons as a bit mask (bit 0 = A) and the POV from the d-pad buttons (12 to 15). */
export function applyPadMap(pad: PadLike, m: PadMap): { axes: number[]; buttons: number; pov: number } {
  const axes = (['lx', 'ly', 'lt', 'rt', 'rx', 'ry'] as PadAxisName[]).map((a) => readAxis(pad, m.axes[a], a === 'lt' || a === 'rt' ? 0 : m.deadzone))
  let buttons = 0
  PAD_BUTTONS.forEach((b, bit) => { if (pad.buttons[m.buttons[b]]?.pressed) buttons |= 1 << bit })
  const up = pad.buttons[12]?.pressed, down = pad.buttons[13]?.pressed, left = pad.buttons[14]?.pressed, right = pad.buttons[15]?.pressed
  let pov = -1
  if (up) pov = right ? 45 : left ? 315 : 0
  else if (down) pov = right ? 135 : left ? 225 : 180
  else if (right) pov = 90
  else if (left) pov = 270
  return { axes, buttons, pov }
}

/** For "Learn": the first control that was just used on this pad (a pressed button, or an axis moved far from rest), or null. */
export function detectControl(pad: PadLike, baselineAxes: readonly number[]): { kind: 'axis' | 'button'; index: number } | null {
  for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i].pressed || pad.buttons[i].value > 0.6) return { kind: 'button', index: i }
  for (let i = 0; i < pad.axes.length; i++) if (Math.abs(pad.axes[i] - (baselineAxes[i] ?? 0)) > 0.6) return { kind: 'axis', index: i }
  return null
}
