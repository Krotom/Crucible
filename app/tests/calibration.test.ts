// The calibration workflow against synthetic data made from known parameters: the fit must find them again, with noise, from a wrong start.
import { describe, expect, it } from 'vitest'
import { parseAccel, parseShots } from '../src/calibration/data'
import { nelderMead } from '../src/calibration/optimize'
import { defaultShotModel, fitShots, predictRange, shotResiduals, type ShotModel } from '../src/calibration/shots'
import { defaultDriveModel, fitDrive, simulateAcceleration } from '../src/calibration/drive'
import { Engine } from '../src/engine/engine'
import { OFFSEASON } from '../src/robots/offseason'
import type { ShotRow } from '../src/calibration/data'

/** A small deterministic noise source (the tests must not depend on Math.random). */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 2 ** 32 - 0.5) * 2 // -1..1
  }
}

describe('optimizer', () => {
  it('finds the minimum inside bounds and stops at a bound when the minimum is outside', () => {
    const f = (x: number[]): number => (x[0] - 3) ** 2 + 4 * (x[1] + 1) ** 2
    const r = nelderMead(f, [0, 0], [{ min: -5, max: 5 }, { min: -5, max: 5 }], { maxEvaluations: 300 })
    expect(r.x[0]).toBeCloseTo(3, 2)
    expect(r.x[1]).toBeCloseTo(-1, 2)
    const b = nelderMead(f, [0, 0], [{ min: -5, max: 2 }, { min: -5, max: 5 }], { maxEvaluations: 300 })
    expect(b.x[0]).toBeCloseTo(2, 3)
  })
})

describe('data files', () => {
  it('reads shots and acceleration CSV, skipping comments, and says which line is wrong', () => {
    const shots = parseShots('# my shots\nflywheel_rps,hood_deg,range_m,height_m\n50,60,4.2\n55;62;5.0;1.83\n')
    expect(shots).toEqual([
      { flywheelRps: 50, hoodDeg: 60, range: 4.2, height: 0, exitHeight: null },
      { flywheelRps: 55, hoodDeg: 62, range: 5.0, height: 1.83, exitHeight: null },
    ])
    expect(parseAccel('t_s,speed_mps\n0,0\n0.1,0.8\n')).toEqual([{ t: 0, speed: 0 }, { t: 0.1, speed: 0.8 }])
    expect(() => parseShots('a,b,c\n50,abc,4\n')).toThrow(/line 2: hood_deg/)
  })
})

describe('shot calibration', () => {
  const truth: ShotModel = { ...defaultShotModel(), efficiency: 0.62, backspin: 0.22 }
  const plan = [[40, 62], [45, 58], [50, 66], [55, 60], [60, 64], [65, 57], [48, 70], [52, 55], [58, 68], [70, 61]]

  it('predicts a longer shot for a faster flywheel', async () => {
    const slow = await predictRange(truth, { flywheelRps: 40, hoodDeg: 60, height: 0, exitHeight: null })
    const fast = await predictRange(truth, { flywheelRps: 60, hoodDeg: 60, height: 0, exitHeight: null })
    expect(slow).not.toBeNull()
    expect(fast!).toBeGreaterThan(slow! * 1.5)
  })

  it('recovers efficiency and backspin from noisy measured shots', async () => {
    const rnd = noise(7)
    const data: ShotRow[] = []
    for (const [rps, hood] of plan) {
      const r = await predictRange(truth, { flywheelRps: rps, hoodDeg: hood, height: 0, exitHeight: null })
      data.push({ flywheelRps: rps, hoodDeg: hood, range: r! + 0.04 * rnd(), height: 0, exitHeight: null })
    }
    // the wrong start: the robot definition's guesses
    const start = { ...truth, efficiency: 0.8, backspin: 0.4 }
    const fit = await fitShots(data, start, { maxEvaluations: 120 })
    expect(fit.after.rms).toBeLessThan(fit.before.rms)
    expect(fit.after.rms).toBeLessThan(0.06) // about the noise
    expect(fit.model.efficiency).toBeCloseTo(0.62, 1)
    expect(Math.abs(fit.model.efficiency - 0.62)).toBeLessThan(0.03)
    const res = await shotResiduals(fit.model, data)
    expect(res.every((r) => r.error !== null && Math.abs(r.error) < 0.15)).toBe(true)
  }, 120_000)
})

describe('drivetrain calibration', () => {
  it('recovers the tire friction from a noisy acceleration log', async () => {
    const times = Array.from({ length: 21 }, (_, i) => i * 0.1)
    const spec = { ...OFFSEASON.drivetrain, mu: 0.9 }
    const e = await Engine.create({
      game: { id: 'g', field: () => ({ length: 200, width: 200, colliders: [{ center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 0.2 }], sensors: [] }), pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.5, dragCoefficient: 0, rollingDamping: 0, color: 0 }], initialLayout: () => [], matchFlow: () => ({ phases: [{ name: 'p', duration: Infinity }] }), onEvent: () => [], hud: () => ({ title: 'g' }) },
      robot: { half: OFFSEASON.bumper, start: { x: -90, y: 0, yaw: 0 }, script: [], drivetrain: spec, chassis: OFFSEASON.contact }, seed: 1, dt: 0.002,
    })
    const truthSpeeds = simulateAcceleration(e, spec, times, 12)
    const rnd = noise(11)
    const data = times.map((t, i) => ({ t, speed: Math.max(0, truthSpeeds[i] + 0.03 * rnd()) }))
    const start = { ...defaultDriveModel(), mu: 1.5 }
    const fit = await fitDrive(data, { start, volts: 12 })
    expect(fit.after.rms).toBeLessThan(fit.before.rms)
    expect(fit.after.rms).toBeLessThan(0.05)
    expect(Math.abs(fit.model.mu - 0.9)).toBeLessThan(0.1)
  }, 120_000)
})
