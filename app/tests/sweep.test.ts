import { describe, expect, it } from 'vitest'
import { record, runSweep, stats } from '../src/engine/sweep'
import { buildSetup } from '../src/engine/setup'

describe('seed sweep', () => {
  it('plays one run per seed, reports each, and is repeatable', async () => {
    const req = { game: 'test' as const, alliance: 'blue' as const, opponent: 'none' as const, stepDt: 0.005, seeds: [1, 2, 3], duration: 8 }
    const seen: number[] = []
    const a = await runSweep(req, (r) => seen.push(r.seed), () => false)
    expect(a.map((r) => r.seed)).toEqual([1, 2, 3]); expect(seen).toEqual([1, 2, 3])
    for (const r of a) { expect(Number.isFinite(r.blue) && Number.isFinite(r.red) && r.wallMs >= 0).toBe(true); expect(r.fouls).toBeGreaterThanOrEqual(0) }
    const b = await runSweep(req, () => {}, () => false)
    expect(b.map((r) => [r.seed, r.blue, r.red])).toEqual(a.map((r) => [r.seed, r.blue, r.red])) // same seeds, same results
  }, 60000)

  it('stops between runs when cancelled', async () => {
    let n = 0
    const out = await runSweep({ game: 'test', alliance: 'blue', opponent: 'none', stepDt: 0.005, seeds: [1, 2, 3, 4, 5], duration: 2 }, () => { n++ }, () => n >= 2)
    expect(out).toHaveLength(2)
  }, 60000)

  it('plays the heavy game and the red alliance too', async () => {
    const out = await runSweep({ game: 'rebuilt', alliance: 'red', opponent: 'ally', stepDt: 0.005, seeds: [7], duration: 2 }, () => {}, () => false)
    expect(out).toHaveLength(1)
  }, 120000)
})

describe('statistics', () => {
  it('mean, sample standard deviation, median and range', () => {
    const s = stats([2, 4, 4, 4, 5, 5, 7, 9])!
    expect(s.mean).toBe(5); expect(s.sd).toBeCloseTo(2.138, 3); expect(s.median).toBe(4.5); expect([s.min, s.max, s.n]).toEqual([2, 9, 8])
    expect(stats([3])).toMatchObject({ mean: 3, sd: 0, median: 3 }); expect(stats([])).toBeNull()
    expect(stats([1, 2, 3])!.median).toBe(2)
  })
  it('counts wins, losses and ties', () => {
    const run = (blue: number, red: number) => ({ seed: 0, blue, red, fouls: 0, wallMs: 0 })
    expect(record([run(3, 1), run(1, 3), run(2, 2), run(5, 0)])).toEqual({ blue: 2, red: 1, tie: 1 })
  })
})

describe('shared setup', () => {
  it('mirrors the red start, keeps typed starts inside the field, and counts the other robots', () => {
    const blue = buildSetup({ mode: 'script', game: 'rebuilt', alliance: 'blue' })
    const red = buildSetup({ mode: 'script', game: 'rebuilt', alliance: 'red' })
    const b = (blue.config.robot as { start: { x: number; y: number; yaw: number } }).start, r = (red.config.robot as { start: { x: number; y: number; yaw: number } }).start
    expect(b).toMatchObject({ x: 1.6, y: 4 }); expect(r.x).toBeCloseTo(16.541 - 1.6, 2); expect(r.yaw).toBeCloseTo(Math.PI)
    const typed = buildSetup({ mode: 'script', game: 'rebuilt', alliance: 'blue', start: { x: 999, y: -3, yawDeg: 90 } })
    const t = (typed.config.robot as { start: { x: number; y: number; yaw: number } }).start
    expect(t.x).toBeCloseTo(16.541, 2); expect(t.y).toBe(0); expect(t.yaw).toBeCloseTo(Math.PI / 2)
    expect(buildSetup({ mode: 'script', game: 'test', opponent: 'both' }).othersHalf).toHaveLength(2); expect(buildSetup({ mode: 'script', game: 'test', opponent: 'none' }).othersHalf).toHaveLength(0)
  })
})
