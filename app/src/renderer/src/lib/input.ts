// Driver input for the robot-in-the-loop sim: a gamepad (browser Gamepad API, standard mapping) or the keyboard,
// presented to the robot as a WPILib Xbox controller on port 0 (axes 0 LX, 1 LY, 2 LT, 3 RT, 4 RX, 5 RY; buttons 1-10:
// A B X Y LB RB Back Start L3 R3 as bits 0-9; one POV). The robot code's own mapping (UniversalController) then applies.

export interface JoystickReading {
  axes: number[]
  /** button bitmask, bit 0 = button 1 */
  buttons: number
  /** POV in degrees, -1 when none */
  pov: number
  source: 'gamepad' | 'keyboard' | 'none'
}

import { loadBindings, type Bindings } from './keybinds'
import { applyPadMap, loadPadMap, type PadMap } from './padmap'

const pressed = new Set<string>()
let bindings: Bindings = loadBindings()
let padMap: PadMap = loadPadMap()

export const getBindings = (): Bindings => bindings
export const setBindings = (b: Bindings): void => { bindings = b; pressed.clear() }
export const getPadMap = (): PadMap => padMap
export const setPadMap = (m: PadMap): void => { padMap = m }

export function installKeyboard(): void {
  // After a dropdown is used with the mouse (Teleop / Auto / Test, speed) it keeps keyboard focus, and the driving keys would then be ignored
  // (or type-ahead into the list). Let go of the focus right after a mouse choice; a keyboard user who is working the list keeps it.
  let pointerAt = -Infinity
  window.addEventListener('pointerdown', () => { pointerAt = performance.now() }, true)
  document.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement && performance.now() - pointerAt < 15000) e.target.blur()
  })
  window.addEventListener('keydown', (e) => {
    pointerAt = -Infinity // the keyboard is in use now

    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    pressed.add(e.code)
  })
  window.addEventListener('keyup', (e) => pressed.delete(e.code))
  window.addEventListener('blur', () => pressed.clear())
}

function fromGamepad(): JoystickReading | null {
  const pads = navigator.getGamepads?.() ?? []
  const p = pads.find((g) => g && g.connected)
  if (!p) return null
  const r = applyPadMap(p, padMap)
  const active = r.axes.some((a) => a !== 0) || r.buttons !== 0 || r.pov !== -1
  return { axes: r.axes, buttons: r.buttons, pov: r.pov, source: active ? 'gamepad' : 'none' }
}

/**
 * Keyboard: W/S forward/back, A/D strafe left/right, Q/E rotate left/right (the sticks: pushing up is negative Y),
 * J = A button (intake), K = B (idle), L = right trigger (shoot), H = left trigger (shoot on the move).
 */
function fromKeyboard(): JoystickReading {
  const k = (action: keyof Bindings): number => (pressed.has(bindings[action]) ? 1 : 0)
  const lx = k('right') - k('left')
  const ly = k('back') - k('forward')
  const rx = k('rotateRight') - k('rotateLeft')
  const axes = [lx, ly, k('leftTrigger'), k('rightTrigger'), rx, 0]
  const buttons = (k('buttonA') ? 1 : 0) | (k('buttonB') ? 2 : 0)
  const active = axes.some((a) => a !== 0) || buttons !== 0
  return { axes, buttons, pov: -1, source: active ? 'keyboard' : 'none' }
}

export function readInput(): JoystickReading {
  const pad = fromGamepad()
  if (pad && pad.source === 'gamepad') return pad
  const kb = fromKeyboard()
  if (kb.source === 'keyboard') return kb
  return pad ?? kb
}

export function sameReading(a: JoystickReading | null, b: JoystickReading): boolean {
  return a !== null && a.buttons === b.buttons && a.pov === b.pov && a.axes.every((v, i) => v === b.axes[i])
}
