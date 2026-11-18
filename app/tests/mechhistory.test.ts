import { describe, expect, it } from 'vitest'
import { MechHistory, sparkPath } from '../src/renderer/src/lib/mechhistory'

const m = (name: string, v: number) => ({ name, position: v, velocity: v * 2, volts: v * 3, amps: v * 4 })

describe('mechanism history', () => {
  it('keeps a sample every 50 ms of sim time per mechanism and drops what is older than the window', () => {
    const h = new MechHistory(10, 0.05)
    for (let i = 0; i <= 700; i++) h.add(i * 0.02, [m('turret', i), m('hood', -i)])
    expect(h.names()).toEqual(['turret', 'hood'])
    const t = h.series.get('turret')!
    expect(t[1].t - t[0].t).toBeGreaterThanOrEqual(0.05 - 1e-9); expect(t[0].t).toBeGreaterThanOrEqual(4 - 1e-9); expect(t.at(-1)!.t).toBeCloseTo(14, 1); expect(t.length).toBeLessThan(210)
    expect(t.at(-1)).toMatchObject({ velocity: t.at(-1)!.position * 2, volts: t.at(-1)!.position * 3, amps: t.at(-1)!.position * 4 })
  })
  it('cuts the history where time goes back (rewind, Load, Reset) and starts again', () => {
    const h = new MechHistory()
    for (let i = 0; i < 100; i++) h.add(i * 0.05, [m('a', i)])
    h.add(2.0, [m('a', -1)])
    const a = h.series.get('a')!; expect(a.at(-1)).toMatchObject({ t: 2.0, position: -1 }); expect(a.every((s, i) => i === 0 || s.t > a[i - 1].t)).toBe(true); expect(a.length).toBeLessThan(45)
    h.clear(); expect(h.names()).toEqual([])
  })
})

describe('sparkline path', () => {
  it('is empty for fewer than two points, spans the box, and puts big values at the top', () => {
    expect(sparkPath([], 100, 26)).toBe(''); expect(sparkPath([1], 100, 26)).toBe('')
    const p = sparkPath([0, 1, 0], 100, 26)
    expect(p.startsWith('M0.0 24.0')).toBe(true); expect(p).toContain('L50.0 2.0'); expect(p.endsWith('L100.0 24.0')).toBe(true)
  })
  it('centres a flat series, pins a given scale, clamps outside it, and never makes NaN', () => {
    expect(sparkPath([5, 5, 5], 100, 26)).toBe('M0.0 13.0L50.0 13.0L100.0 13.0')
    expect(sparkPath([0, 50, 200], 100, 26, 0, 100)).toBe('M0.0 24.0L50.0 13.0L100.0 2.0')
    expect(sparkPath([1, 2, 3, 4], 100, 26)).not.toContain('NaN'); expect(sparkPath([0, 0], 100, 26, 0)).not.toContain('NaN')
  })
})
