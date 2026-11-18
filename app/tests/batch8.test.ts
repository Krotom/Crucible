import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fuzzyScore, rank, type Command } from '../src/renderer/src/lib/cmdpalette'
import { allianceHex, CB_HEX, getA11y, NORMAL_HEX, setA11y, zoomFor } from '../src/renderer/src/lib/a11y'
import { TR, translate } from '../src/renderer/src/lib/i18n'
import { captureValues, cleanName, PresetStore, type KeyValueStore } from '../src/renderer/src/lib/presets'
import { kindOf, ToastQueue } from '../src/renderer/src/lib/toast'
import { CHANGELOG, compareVersions, entriesSince, interpretRelease, parseVersion } from '../src/renderer/src/lib/versions'
import { SHORTCUTS } from '../src/renderer/src/lib/shortcuts'

const memory = (): KeyValueStore & { data: Record<string, string> } => { const data: Record<string, string> = {}; return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v } } }

describe('toasts', () => {
  it('stack, expire and drop the oldest past the limit', () => {
    const q = new ToastQueue(3)
    for (const t of ['a', 'b', 'c', 'd']) q.push(t, 'info', 0)
    expect(q.visible(1).map((t) => t.text)).toEqual(['b', 'c', 'd'])
    expect(q.visible(4001)).toEqual([]) // info lasts 4 s
    expect(q.history.map((h) => h.text)).toEqual(['a', 'b', 'c', 'd']) // nothing is lost
  })
  it('merges a repeated message into a counter and restarts its timer; errors stay longer than info', () => {
    const q = new ToastQueue()
    q.push('Saved x', 'ok', 0); const t = q.push('Saved x', 'ok', 3000)!
    expect(t.count).toBe(2); expect(q.visible(6000)).toHaveLength(1) // restarted at 3000, ok lasts 3.5 s
    q.push('bad', 'error', 0); expect(q.visible(8000).some((x) => x.text === 'bad')).toBe(true)
    expect(q.visible(10000).some((x) => x.text === 'bad')).toBe(false)
  })
  it('ignores blank text, dismisses by id, and guesses a kind from the words', () => {
    const q = new ToastQueue(); expect(q.push('   ')).toBeNull(); const t = q.push('hello', 'info', 0)!; q.dismiss(t.id); expect(q.visible(1)).toEqual([])
    expect(kindOf('Could not open x.wpilog')).toBe('error'); expect(kindOf('Saved /tmp/a.png')).toBe('ok'); expect(kindOf('Nothing is plotted yet')).toBe('warn'); expect(kindOf('Paused: shot')).toBe('warn'); expect(kindOf('Reference log a')).toBe('info')
  })
  it('keeps a bounded history', () => { const q = new ToastQueue(4, 3); for (let i = 0; i < 10; i++) q.push('m' + i, 'info', 0); expect(q.history.map((h) => h.text)).toEqual(['m7', 'm8', 'm9']) })
})

describe('command palette matching', () => {
  const cmds: Command[] = [{ id: 'a', label: 'Reset the sim' }, { id: 'b', label: 'Start / stop the sim' }, { id: 'c', label: 'Switch dark / light theme' }, { id: 'd', label: 'Tune tab', group: 'View' }, { id: 'e', label: 'Robot tab', group: 'View' }]
  it('matches subsequences, rejects non-matches, and is case-insensitive', () => {
    expect(fuzzyScore('rst', 'Reset the sim')).not.toBeNull(); expect(fuzzyScore('xyz', 'Reset the sim')).toBeNull(); expect(fuzzyScore('RESET', 'reset')).not.toBeNull(); expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('tsr', 'Reset')).toBeNull() // order matters
  })
  it('puts prefix and word-start matches first', () => {
    expect(rank(cmds, 'res')[0].id).toBe('a'); expect(rank(cmds, 'dark')[0].id).toBe('c'); expect(rank(cmds, 'tune')[0].id).toBe('d')
    expect(rank(cmds, 'tab').map((c) => c.id).sort()).toEqual(['d', 'e']); expect(rank(cmds, 'zzz')).toEqual([])
  })
  it('ignores accents and the Turkish dotless i, so plain letters find Turkish names', () => {
    expect(fuzzyScore('turk', 'Language: Türkçe')).not.toBeNull(); expect(fuzzyScore('istanbul', 'İSTANBUL')).not.toBeNull(); expect(fuzzyScore('kisa', 'kısa yol')).not.toBeNull(); expect(fuzzyScore('Türkçe', 'language turkce')).not.toBeNull()
    expect(rank([{ id: 'a', label: 'Language: English' }, { id: 'b', label: 'Language: Türkçe' }], 'turk').map((c) => c.id)).toEqual(['b'])
  })
  it('lists everything in table order for an empty query, up to the limit', () => { expect(rank(cmds, '').map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']); expect(rank(cmds, '', 2)).toHaveLength(2) })
  it('has a shortcut for opening it, with no clash among the keys', () => {
    expect(SHORTCUTS.find((s) => s.run === 'palette')?.key).toBe('ctrl+k')
    const keys = SHORTCUTS.map((s) => s.key); expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('session presets', () => {
  it('saves, lists sorted, reads back and deletes', () => {
    const s = new PresetStore(memory())
    expect(s.save('Qual 3', { alliance: 'red', 'bat-on': true })).toBeNull(); expect(s.save('Auto test', { alliance: 'blue' })).toBeNull()
    expect(s.list().map((p) => p.name)).toEqual(['Auto test', 'Qual 3']); expect(s.get('qual 3')?.values).toEqual({ alliance: 'red', 'bat-on': true })
    expect(s.delete('QUAL 3')).toBe(true); expect(s.delete('Qual 3')).toBe(false); expect(s.list()).toHaveLength(1)
  })
  it('replaces a preset of the same name instead of duplicating it, and cleans names', () => {
    const s = new PresetStore(memory()); s.save('A', { x: '1' }); s.save('  a ', { x: '2' })
    expect(s.list()).toHaveLength(1); expect(s.list()[0].values.x).toBe('2'); expect(cleanName('  a   b  ')).toBe('a b'); expect(cleanName('x'.repeat(100))).toHaveLength(40)
  })
  it('refuses an empty name and too many presets, and survives missing or damaged storage', () => {
    const s = new PresetStore(memory()); expect(s.save('   ', {})).toMatch(/name/)
    for (let i = 0; i < 30; i++) expect(s.save('p' + i, {})).toBeNull(); expect(s.save('one more', {})).toMatch(/At most/); expect(s.save('p3', { y: '1' })).toBeNull() // replacing is still fine
    expect(new PresetStore(null).list()).toEqual([]); expect(new PresetStore(null).save('x', {})).toMatch(/unavailable/)
    const bad = memory(); bad.data['crucible-presets'] = '{not json'; expect(new PresetStore(bad).list()).toEqual([])
    bad.data['crucible-presets'] = JSON.stringify([{ name: 'ok', values: { a: 1, b: 'x', c: true } }, { nope: 1 }, 'x']); expect(new PresetStore(bad).list()).toEqual([{ name: 'ok', values: { b: 'x', c: true }, saved: 0 }])
  })
  it('captures only the controls that exist', () => { expect(captureValues(['a', 'b', 'c'], (id) => (id === 'b' ? undefined : id === 'a' ? 'x' : true))).toEqual({ a: 'x', c: true }) })
})

describe('versions and the update check', () => {
  it('compares versions the way people expect', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1); expect(compareVersions('v1.2', '1.2.0')).toBe(0); expect(compareVersions('0.9.9', '1.0.0')).toBe(-1); expect(compareVersions('abc', '1.0.0')).toBeNull(); expect(parseVersion('v2.3.4-beta')).toEqual([2, 3, 4])
  })
  it('shows what is new since the last seen version, and everything the first time', () => {
    const log = [{ version: '1.2.0', title: 'c', items: [] }, { version: '1.1.0', title: 'b', items: [] }, { version: '1.0.0', title: 'a', items: [] }]
    expect(entriesSince('1.0.0', '1.2.0', log).map((r) => r.version)).toEqual(['1.2.0', '1.1.0']); expect(entriesSince(null, '1.1.0', log).map((r) => r.version)).toEqual(['1.1.0', '1.0.0'])
    expect(entriesSince('1.2.0', '1.2.0', log)).toEqual([]); expect(entriesSince('1.0.0', '1.0.0', log)).toEqual([])
    expect(CHANGELOG.length).toBeGreaterThan(0)
  })
  it('reads a release answer: newer, current, no release yet, server trouble, junk', () => {
    expect(interpretRelease('1.1.0', 200, { tag_name: 'v1.2.0', html_url: 'https://github.com/x/y/releases/v1.2.0', body: 'notes' })).toEqual({ status: 'newer', latest: '1.2.0', url: 'https://github.com/x/y/releases/v1.2.0', notes: 'notes' })
    expect(interpretRelease('1.1.0', 200, { tag_name: 'v1.1.0' })).toEqual({ status: 'current', latest: '1.1.0' }); expect(interpretRelease('1.1.0', 200, { tag_name: 'v1.0.0' }).status).toBe('current')
    expect(interpretRelease('1.1.0', 404, {}).status).toBe('none'); expect(interpretRelease('1.1.0', 500, {}).status).toBe('error'); expect(interpretRelease('1.1.0', 200, { tag_name: 'nightly' }).status).toBe('error'); expect(interpretRelease('1.1.0', 200, null).status).toBe('error')
    expect(interpretRelease('1.1.0', 200, { tag_name: 'v2.0.0', html_url: 'javascript:alert(1)' }).url).toBeUndefined() // only https links are offered
  })
})

describe('Turkish interface', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  const mainTs = readFileSync(new URL('../src/renderer/src/main.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/renderer/src/lib/chrome.ts', import.meta.url), 'utf8')
  it('translates known text, leaves unknown text alone, and does nothing for English', () => {
    expect(translate('Reset', 'tr')).toBe('Sıfırla'); expect(translate('Something new', 'tr')).toBe('Something new'); expect(translate('Reset', 'en')).toBe('Reset')
  })
  it('only has keys that still exist in the interface, so a renamed label cannot silently lose its translation', () => {
    const text = html.replace(/<[^>]*>/g, '>|<') + mainTs
    const missing = Object.keys(TR).filter((k) => !text.includes(k))
    expect(missing).toEqual([])
  })
  it('has no empty translations and keeps keys that are only numbers or units out', () => { for (const [k, v] of Object.entries(TR)) { expect(v.trim().length, k).toBeGreaterThan(0); expect(/^[\d.\s]+$/.test(k), k).toBe(false) } })
  it('covers the main labels of every tab', () => { for (const k of ['Session', 'Robot', 'Topics', 'Analysis', 'Tune', 'Start sim', 'Launch robot', 'Match summary', 'Calibration', 'Close']) expect(TR[k], k).toBeTruthy() })
})

describe('colour-blind CSS palette', () => {
  const css = readFileSync(new URL('../src/renderer/src/style.css', import.meta.url), 'utf8')
  const lum = (hex: string): number => { const h = parseInt(hex.slice(1), 16); const c = [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const contrast = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const pick = (re: RegExp): string => re.exec(css)![1]
  for (const [theme, rule, bg] of [['dark', /:root\[data-cb\]:not\(\[data-theme='light'\]\) \{([^}]*)\}/, /:root \{[^}]*--panel: (#[0-9a-f]{6})/], ['light', /:root\[data-cb\]\[data-theme='light'\] \{([^}]*)\}/, /\[data-theme='light'\] \{[^}]*--panel: (#[0-9a-f]{6})/]] as const) {
    it(`${theme}: blue and orange differ in lightness and both read on the panel`, () => {
      const body = rule.exec(css)![1]; const blue = /--blue: (#[0-9a-f]{6})/.exec(body)![1], red = /--red: (#[0-9a-f]{6})/.exec(body)![1], panel = pick(bg)
      expect(Math.abs(lum(blue) - lum(red))).toBeGreaterThan(0.1); expect(contrast(blue, panel)).toBeGreaterThan(3.5); expect(contrast(red, panel)).toBeGreaterThan(3.5)
    })
  }
})

describe('accessibility switches', () => {
  it('swaps the alliance colours and sets the zoom', () => {
    setA11y({ colorblind: false, large: false }); expect(allianceHex('red')).toBe(NORMAL_HEX.red); expect(zoomFor(getA11y())).toBe(1)
    setA11y({ colorblind: true, large: true }); expect(allianceHex('red')).toBe(CB_HEX.red); expect(allianceHex('blue')).toBe(CB_HEX.blue); expect(zoomFor(getA11y())).toBeGreaterThan(1)
    expect(CB_HEX.red).not.toBe(NORMAL_HEX.red); setA11y({ colorblind: false, large: false })
  })
  it('keeps the two colour-blind-safe colours far apart in lightness (they must differ for people who cannot tell hue)', () => {
    const lum = (h: number): number => { const c = [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
    expect(Math.abs(lum(CB_HEX.blue) - lum(CB_HEX.red))).toBeGreaterThan(0.1)
  })
})
