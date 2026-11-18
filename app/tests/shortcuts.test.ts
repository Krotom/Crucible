import { describe, expect, it } from 'vitest'
import { DRIVING_KEYS, SHORTCUTS, findShortcut, keyLabel, keyName } from '../src/renderer/src/lib/shortcuts'

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('keyboard shortcuts', () => {
  it('never uses a key the robot is driven with', () => {
    for (const s of SHORTCUTS) expect(DRIVING_KEYS, `${s.key} (${s.label}) is a driving key`).not.toContain(s.key)
    // also not with Shift held: Shift+W would still read as W to the robot
    for (const s of SHORTCUTS) expect(DRIVING_KEYS, s.key).not.toContain(s.key.replace('shift+', ''))
  })
  it('has no duplicate keys or actions', () => {
    const keys = SHORTCUTS.map((s) => s.key); expect(new Set(keys).size).toBe(keys.length)
    const runs = SHORTCUTS.map((s) => s.run); expect(new Set(runs).size).toBe(runs.length)
  })
  it('turns keydown events into the table notation', () => {
    expect(keyName(ev(' '))).toBe(' ')
    expect(keyName(ev('Enter', { ctrlKey: true }))).toBe('ctrl+enter')
    expect(keyName(ev('Enter', { metaKey: true }))).toBe('ctrl+enter')
    expect(keyName(ev('R', { shiftKey: true }))).toBe('shift+r')
    expect(keyName(ev('N', { shiftKey: true }))).toBe('shift+n')
    expect(keyName(ev('n'))).toBe('n')
    expect(keyName(ev('?', { shiftKey: true }))).toBe('?')
    expect(keyName(ev('F', { ctrlKey: true }))).toBe('ctrl+f')
    expect(keyName(ev('Shift', { shiftKey: true }))).toBeNull()
    expect(keyName(ev('a', { altKey: true }))).toBeNull()
  })
  it('finds a shortcut for each table entry and none for the driving keys', () => {
    for (const s of SHORTCUTS) expect(findShortcut(s.key)).toBe(s)
    for (const k of DRIVING_KEYS) expect(findShortcut(keyName(ev(k)))).toBeUndefined()
  })
  it('prints readable key names', () => {
    expect(keyLabel(' ')).toBe('Space'); expect(keyLabel('ctrl+enter')).toBe('Ctrl+Enter'); expect(keyLabel('shift+r')).toBe('Shift+R'); expect(keyLabel('?')).toBe('?')
  })
})
