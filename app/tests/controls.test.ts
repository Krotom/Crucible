import { describe, expect, it } from 'vitest'
import { bind, cleanBindings, codeLabel, DEFAULT_KEYS, DRIVE_ACTIONS, reservedCodes } from '../src/renderer/src/lib/keybinds'
import { applyPadMap, cleanPadMap, DEFAULT_PADMAP, detectControl, readAxis, type PadLike } from '../src/renderer/src/lib/padmap'

const pad = (axes: number[] = [0, 0, 0, 0], pressed: number[] = [], values: Record<number, number> = {}): PadLike => ({
  axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: values[i] ?? (pressed.includes(i) ? 1 : 0) })),
})

describe('keyboard bindings', () => {
  it('start as the documented driving keys, one per action, none of them shortcuts', () => {
    expect(Object.values(DEFAULT_KEYS)).toHaveLength(DRIVE_ACTIONS.length); expect(new Set(Object.values(DEFAULT_KEYS)).size).toBe(DRIVE_ACTIONS.length)
    const reserved = reservedCodes(); for (const c of Object.values(DEFAULT_KEYS)) expect(reserved.has(c), c).toBe(false)
  })
  it('reserve what shortcuts use (letters, digits, Space, arrows ...) and modifiers, but not Ctrl combinations', () => {
    const r = reservedCodes()
    for (const c of ['KeyP', 'KeyF', 'KeyT', 'KeyC', 'KeyM', 'KeyB', 'KeyN', 'Digit1', 'Digit5', 'Space', 'Period', 'ArrowLeft', 'Escape', 'ShiftLeft', 'Tab']) expect(r.has(c), c).toBe(true)
    for (const c of ['KeyW', 'KeyV', 'KeyZ', 'ArrowUp', 'Numpad8']) expect(r.has(c), c).toBe(false); expect(r.has('KeyG')).toBe(true) // G opens this dialog
  })
  it('binds a free key, and says why not for shortcut keys and keys another action uses', () => {
    const ok = bind(DEFAULT_KEYS, 'forward', 'ArrowUp'); expect(ok.ok && ok.bindings.forward).toBe('ArrowUp')
    const clash = bind(DEFAULT_KEYS, 'forward', 'KeyS'); expect(clash.ok).toBe(false); expect(!clash.ok && clash.error).toContain('already drives "Back"')
    const sc = bind(DEFAULT_KEYS, 'forward', 'KeyT'); expect(sc.ok).toBe(false); expect(!sc.ok && sc.error).toContain('shortcut')
    expect(bind(DEFAULT_KEYS, 'forward', 'KeyW').ok).toBe(true) // the key it already has
  })
  it('repairs saved bindings: junk, shortcut keys and doubles fall back to free defaults', () => {
    expect(cleanBindings(null)).toEqual(DEFAULT_KEYS); expect(cleanBindings('x')).toEqual(DEFAULT_KEYS)
    const b = cleanBindings({ forward: 'KeyT', back: 'ArrowDown', left: 'ArrowDown', right: 42, rotateLeft: 'Key W!', bogus: 'KeyZ' })
    expect(b.back).toBe('ArrowDown'); expect(b.forward).toBe('KeyW'); expect(b.left).toBe('KeyA'); expect(b.right).toBe('KeyD')
    expect(new Set(Object.values(b)).size).toBe(10); expect(Object.keys(b).sort()).toEqual(Object.keys(DEFAULT_KEYS).sort())
    // a saved choice that takes another action's default key: both still end up with distinct keys
    const swap = cleanBindings({ forward: 'KeyS' }); expect(swap.forward).toBe('KeyS'); expect(swap.back).not.toBe('KeyS'); expect(new Set(Object.values(swap)).size).toBe(10)
  })
  it('prints readable key names', () => {
    expect([codeLabel('KeyW'), codeLabel('Digit3'), codeLabel('ArrowUp'), codeLabel('Numpad4'), codeLabel('Space'), codeLabel('BracketLeft'), codeLabel('F5')]).toEqual(['W', '3', '↑', 'Num 4', 'Space', '[', 'F5'])
  })
})

describe('gamepad mapping', () => {
  it('maps the standard layout: sticks with a dead zone, triggers from buttons, ten buttons as bits, the d-pad as the POV', () => {
    const r = applyPadMap(pad([0.5, -0.8, 0.3, 0.02], [0, 3, 12, 15], { 6: 0.4, 7: 1 }), DEFAULT_PADMAP)
    expect(r.axes).toEqual([0.5, -0.8, 0.4, 1, 0.3, 0]) // ry 0.02 is inside the dead zone
    expect(r.buttons).toBe(0b1001); expect(r.pov).toBe(45)
    expect(applyPadMap(pad(), DEFAULT_PADMAP)).toEqual({ axes: [0, 0, 0, 0, 0, 0], buttons: 0, pov: -1 })
    expect(applyPadMap(pad([], [13, 14]), DEFAULT_PADMAP).pov).toBe(225); expect(applyPadMap(pad([], [14]), DEFAULT_PADMAP).pov).toBe(270)
  })
  it('follows a remapped button or axis, inversion and dead zone', () => {
    const m = cleanPadMap({ buttons: { A: 5 }, axes: { ly: { kind: 'axis', index: 3, invert: true }, lt: { kind: 'axis', index: 4, invert: false } }, deadzone: 0.2 })
    const r = applyPadMap(pad([0, 0, 0, 0.7, 0.9], [5]), m)
    expect(r.buttons).toBe(0b100001) // A now reads physical button 5, which RB reads too: one physical button may stand for two controls
    expect(r.axes[1]).toBeCloseTo(-0.7); expect(r.axes[2]).toBeCloseTo(0.9)
    expect(applyPadMap(pad([0, 0, 0, 0.15], [0]), m)).toMatchObject({ buttons: 0 }); expect(applyPadMap(pad([0, 0, 0, 0.15]), m).axes[1]).toBe(0) // inside the new dead zone
    expect(readAxis(pad([0.5]), { kind: 'axis', index: 9, invert: false }, 0)).toBe(0) // a missing axis reads as rest
  })
  it('repairs a saved mapping and keeps the dead zone sane', () => {
    expect(cleanPadMap(null)).toEqual(DEFAULT_PADMAP); expect(cleanPadMap('x')).toEqual(DEFAULT_PADMAP)
    const m = cleanPadMap({ buttons: { A: -3, B: 99, X: 1.5, Y: 7 }, axes: { lx: { kind: 'nonsense', index: 'a', invert: 'yes' } }, deadzone: 5 })
    expect(m.buttons).toMatchObject({ A: 0, B: 1, X: 2, Y: 7 }); expect(m.axes.lx).toEqual({ kind: 'axis', index: 0, invert: false }); expect(m.deadzone).toBe(0.4); expect(cleanPadMap({ deadzone: NaN }).deadzone).toBe(DEFAULT_PADMAP.deadzone)
  })
  it('learns the first control used: a pressed button, else an axis moved far from where it rested', () => {
    expect(detectControl(pad(), [0, 0, 0, 0])).toBeNull(); expect(detectControl(pad([0.2, 0.1]), [0, 0])).toBeNull()
    expect(detectControl(pad([0, 0.9, 0, 0]), [0, 0, 0, 0])).toEqual({ kind: 'axis', index: 1 }); expect(detectControl(pad([0, 0.9], [4]), [0, 0])).toEqual({ kind: 'button', index: 4 })
    expect(detectControl(pad([0.9, 0]), [0.9, 0])).toBeNull() // an axis resting at 0.9 (some triggers do) is not "moved"
    expect(detectControl(pad([], [], { 7: 0.8 }), [])).toEqual({ kind: 'button', index: 7 }) // an analog trigger pulled
  })
})
