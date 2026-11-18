import { describe, expect, it } from 'vitest'
import { describe as words, moved, NO_EFFECT, pctChange, rowFrom, sensitivity, strength } from '../src/calibration/sensitivity'
import { TUNE_DEFS } from '../src/engine/tuning'

describe('sensitivity arithmetic', () => {
  it('moves a value by a fraction and keeps it inside its range', () => {
    const d = { min: 0.4, max: 2 }
    expect(moved(d, 1, 0.1)).toBeCloseTo(1.1); expect(moved(d, 1, -0.1)).toBeCloseTo(0.9); expect(moved(d, 1.95, 0.1)).toBe(2); expect(moved(d, 0.41, -0.1)).toBe(0.4)
  })
  it('gives percent changes and refuses to divide by nothing', () => {
    expect(pctChange(10, 12, 10)).toBeCloseTo(20); expect(pctChange(12, 10, 10)).toBeCloseTo(-20); expect(pctChange(null, 1, 1)).toBeNull(); expect(pctChange(1, 2, 0)).toBeNull(); expect(pctChange(1, 2, null)).toBeNull()
    expect(strength(-30, 5)).toBe(30); expect(strength(null, null)).toBe(0)
  })
  it('says in words what a row does, and "no effect" when nothing moved', () => {
    const def = TUNE_DEFS[0]; const same = { speed: 3, gentle: 1, range: 4 }
    expect(words(rowFrom(def, 1, 1.1, 1.2, same, same, same))).toBe('no effect on these probes')
    expect(words(rowFrom(def, 0.9, 1, 1.1, { speed: 3, gentle: 1, range: 4 }, { speed: 3, gentle: 1, range: 4 }, { speed: 3.3, gentle: 1, range: 4 }))).toBe('full-power launch +10.0%')
    expect(words(rowFrom(def, 0.9, 1, 1.1, { speed: 3, gentle: 1, range: 4 }, { speed: 3, gentle: 1, range: 4 }, { speed: 3, gentle: 1, range: 3.2 }))).toBe('shot range −20.0%')
    expect(NO_EFFECT).toBeGreaterThan(0)
  })
})

describe('sensitivity of the real model', () => {
  it('ranks the values sensibly: shot efficiency moves the range a lot, mass and friction move the drive, bumper friction touches neither probe', async () => {
    const r = await sensitivity({})
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]))
    expect(r.rows).toHaveLength(TUNE_DEFS.length); expect(r.rows.map((x) => x.strength)).toEqual([...r.rows.map((x) => x.strength)].sort((a, b) => b - a))
    expect(r.base.speed).toBeGreaterThan(0.5); expect(r.base.speed).toBeLessThan(4); expect(r.base.range).toBeGreaterThan(2)
    expect(by.efficiency.rangePct!).toBeGreaterThan(25); expect(by.efficiency.rangePct!).toBeLessThan(45) // range grows about with speed squared: (1.1² − 0.9²) = 40%, less drag; expect(Math.abs(by.efficiency.speedPct ?? 0)).toBeLessThan(NO_EFFECT) // the drive does not care about the shooter
    expect(by.backspin.rangePct!).toBeGreaterThan(0); expect(Math.abs(by.backspin.speedPct ?? 0)).toBeLessThan(NO_EFFECT)
    expect(by.mass.gentlePct!).toBeLessThan(-2); expect(Math.abs(by.mass.speedPct ?? 0)).toBeLessThan(NO_EFFECT) /* full power is grip-limited: weight cancels */; expect(Math.abs(by.mass.rangePct ?? 0)).toBeLessThan(NO_EFFECT) // heavier is slower when the motors are the limit
    expect(Math.abs(by.mu.speedPct ?? 0)).toBeGreaterThan(2); expect(Math.abs(by.mu.gentlePct ?? 0)).toBeLessThan(1) /* grip hardly matters when the motors are the limit */; expect(Math.abs(by.mu.rangePct ?? 0)).toBeLessThan(NO_EFFECT)
    expect(by.bumperFriction.strength).toBeLessThan(NO_EFFECT); expect(words(by.bumperFriction)).toBe('no effect on these probes')
  }, 120000)
  it('measures around what is set now: a value at its limit is only moved one way', async () => {
    const r = await sensitivity({ mu: 2 })
    const mu = r.rows.find((x) => x.key === 'mu')!
    expect(mu.value).toBe(2); expect(mu.high).toBe(2); expect(mu.low).toBeCloseTo(1.8)
  }, 120000)
})
