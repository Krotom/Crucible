import { describe, expect, it } from 'vitest'
import { LiveSeries, indexAt } from '../src/renderer/src/lib/store'

describe('LiveSeries memory', () => {
  it('keeps a run of equal values as its first and last sample, so steps stay exact', () => {
    const s = new LiveSeries('/x', 'double')
    for (let i = 0; i < 1000; i++) s.push(i * 0.01, 5)
    s.push(10, 7)
    expect(s.times.length).toBe(3)
    expect(s.get(indexAt(s.times, 5))).toBe(5) // inside the run
    expect(s.times[1]).toBeCloseTo(9.99, 6) // the run's last sample moved on
    expect(s.get(indexAt(s.times, 10))).toBe(7)
  })
  it('compares arrays by content', () => {
    const s = new LiveSeries('/a', 'double[]')
    for (let i = 0; i < 100; i++) s.push(i, Float64Array.of(1, 2, 3))
    s.push(100, Float64Array.of(1, 2, 4))
    expect(s.times.length).toBe(3)
  })
  it('keeps a bounded number of changing samples', () => {
    const s = new LiveSeries('/c', 'double')
    for (let i = 0; i < 100000; i++) s.push(i * 0.01, i)
    expect(s.times.length).toBeLessThan(17001)
    expect(s.get(s.times.length - 1)).toBe(99999)
  })
})
