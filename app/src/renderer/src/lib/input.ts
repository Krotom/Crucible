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

const pressed = new Set<string>()

export function installKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    pressed.add(e.code)
  })
  window.addEventListener('keyup', (e) => pressed.delete(e.code))
  window.addEventListener('blur', () => pressed.clear())
}

const dead = (v: number): number => (Math.abs(v) < 0.06 ? 0 : v)

function fromGamepad(): JoystickReading | null {
  const pads = navigator.getGamepads?.() ?? []
  const p = pads.find((g) => g && g.connected)
  if (!p) return null
  const b = (i: number): number => p.buttons[i]?.value ?? 0
  const axes = [dead(p.axes[0] ?? 0), dead(p.axes[1] ?? 0), b(6), b(7), dead(p.axes[2] ?? 0), dead(p.axes[3] ?? 0)]
  // standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 8 Back, 9 Start, 10 L3, 11 R3
  const order = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11]
  let buttons = 0
  order.forEach((src, bit) => { if (p.buttons[src]?.pressed) buttons |= 1 << bit })
  const up = p.buttons[12]?.pressed, down = p.buttons[13]?.pressed, left = p.buttons[14]?.pressed, right = p.buttons[15]?.pressed
  let pov = -1
  if (up) pov = right ? 45 : left ? 315 : 0
  else if (down) pov = right ? 135 : left ? 225 : 180
  else if (right) pov = 90
  else if (left) pov = 270
  const active = axes.some((a) => a !== 0) || buttons !== 0 || pov !== -1
  return { axes, buttons, pov, source: active ? 'gamepad' : 'none' }
}

/**
 * Keyboard: W/S forward/back, A/D strafe left/right, Q/E rotate left/right (the sticks: pushing up is negative Y),
 * J = A button (intake), K = B (idle), L = right trigger (shoot), H = left trigger (shoot on the move).
 */
function fromKeyboard(): JoystickReading {
  const k = (c: string): number => (pressed.has(c) ? 1 : 0)
  const lx = k('KeyD') - k('KeyA')
  const ly = k('KeyS') - k('KeyW')
  const rx = k('KeyE') - k('KeyQ')
  const axes = [lx, ly, k('KeyH'), k('KeyL'), rx, 0]
  const buttons = (k('KeyJ') ? 1 : 0) | (k('KeyK') ? 2 : 0)
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
