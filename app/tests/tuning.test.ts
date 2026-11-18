import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { buildSetup } from '../src/engine/setup'
import { applyTune, changedKeys, cleanTune, defaultTune, FLOOR_PRESETS, TUNE_DEFS } from '../src/engine/tuning'
import { simulateAcceleration } from '../src/calibration/drive'
import { OFFSEASON } from '../src/robots/offseason'
import { parseParamNotes, summarize } from '../src/renderer/src/lib/guesses'

const base = { drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact }

describe('tune parameters', () => {
  it('keeps known keys with finite numbers, clamped to their range, and drops the rest', () => {
    expect(cleanTune({ mu: 1.3, mass: 500, efficiency: -4, backspin: 'x', bogus: 1, bumperFriction: NaN })).toEqual({ mu: 1.3, mass: 70, efficiency: 0.3 })
    expect(cleanTune(null)).toEqual({}); expect(cleanTune('a')).toEqual({}); expect(cleanTune({ mu: Infinity })).toEqual({})
  })
  it('has sane definitions: unique keys, min < default < max for the real robot, presets inside the friction range', () => {
    const d = defaultTune(base)
    expect(new Set(TUNE_DEFS.map((x) => x.key)).size).toBe(TUNE_DEFS.length)
    for (const def of TUNE_DEFS) { expect(def.min < def.max && def.step > 0).toBe(true); expect(d[def.key] >= def.min && d[def.key] <= def.max, `${def.key} default ${d[def.key]} outside ${def.min}..${def.max}`).toBe(true) }
    const mu = TUNE_DEFS.find((x) => x.key === 'mu')!
    for (const p of FLOOR_PRESETS) expect(p.mu >= mu.min && p.mu <= mu.max).toBe(true)
  })
  it('lays values over a definition without touching it', () => {
    const before = JSON.stringify([OFFSEASON.drivetrain.mu, OFFSEASON.balls?.shooter.efficiency, OFFSEASON.contact.friction])
    const t = applyTune(base, { mu: 0.8, mass: 60, efficiency: 0.5, bumperFriction: 0.3 })
    expect([t.drivetrain.mu, t.drivetrain.mass, t.balls?.shooter.efficiency, t.contact.friction]).toEqual([0.8, 60, 0.5, 0.3])
    expect(t.balls?.shooter.backspin).toBe(OFFSEASON.balls?.shooter.backspin) // not mentioned: unchanged
    expect(JSON.stringify([OFFSEASON.drivetrain.mu, OFFSEASON.balls?.shooter.efficiency, OFFSEASON.contact.friction])).toBe(before)
    expect(applyTune(base, {}).drivetrain).toEqual(base.drivetrain)
  })
  it('reports which values differ from the definition', () => {
    const d = defaultTune(base)
    expect(changedKeys({ mu: d.mu, mass: d.mass + 1, efficiency: d.efficiency }, d)).toEqual(['mass']); expect(changedKeys({}, d)).toEqual([])
  })
  it('reaches the simulation setup, and a sim without a tune is untouched by an earlier one', () => {
    const a = buildSetup({ mode: 'robot', game: 'test', tune: { mu: 0.7 } }).config.robot as { drivetrain: { mu: number } }
    const b = buildSetup({ mode: 'robot', game: 'test' }).config.robot as { drivetrain: { mu: number } }
    expect(a.drivetrain.mu).toBe(0.7); expect(b.drivetrain.mu).toBe(OFFSEASON.drivetrain.mu)
  })
})

describe('tuning a running engine', () => {
  it('tire friction acts at once: less grip, slower start', async () => {
    const e = await Engine.create(buildSetup({ mode: 'robot', game: 'test' }).config as never)
    const spec = (e.drivetrain as { spec: typeof OFFSEASON.drivetrain }).spec
    const fast = simulateAcceleration(e, spec, [0.25], 12)[0]
    e.tune({ mu: 0.45 })
    const slow = simulateAcceleration(e, spec, [0.25], 12)[0]
    expect(slow).toBeLessThan(fast * 0.8)
    e.dispose()
  }, 60000)
  it('shot values act at once; mass and bumper friction wait for the next reset', async () => {
    const e = await Engine.create(buildSetup({ mode: 'robot', game: 'test' }).config as never)
    e.tune({ efficiency: 0.5, backspin: 0.05, mass: 66, bumperFriction: 0.2 })
    const shooter = (e.ballSystem as unknown as { spec: { shooter: { efficiency: number; backspin: number } } }).spec.shooter
    expect([shooter.efficiency, shooter.backspin]).toEqual([0.5, 0.05])
    expect((e as unknown as { robotMass: number }).robotMass).toBe(OFFSEASON.drivetrain.mass) // the body is still the old one
    e.reset(); expect((e as unknown as { robotMass: number }).robotMass).toBe(66)
    e.dispose()
  }, 60000)
})

describe('guess badges', () => {
  const yaml = readFileSync(new URL('../robots/offseason/robot.yaml', import.meta.url), 'utf8')
  it('reads the source tags of the real robot definition', () => {
    const notes = parseParamNotes(yaml)
    const by = Object.fromEntries(notes.map((n) => [n.path, n]))
    expect(by['chassis.mass']).toMatchObject({ tag: 'GUESS', value: '52' }); expect(by['chassis.mass'].note).toContain('robot with bumpers')
    expect(by['swerve.wheelRadius'].tag).toBe('CODE'); expect(by['swerve.mu'].tag).toBe('GUESS')
    const s = summarize(notes); expect(s.total).toBeGreaterThan(20); expect(s.guesses).toBeGreaterThan(5); expect(s.byTag.CODE).toBeGreaterThan(5)
  })
  it('handles small inputs: flow-mapping items, no tags, odd lines', () => {
    expect(parseParamNotes('a:\n  x: 1 # GUESS: why\n  y: 2\n  - { id: 3, name: arm, gear: 5 }  # CAD: from the model\nb: 4 # CODE source')).toEqual([
      { path: 'a.x', value: '1', tag: 'GUESS', note: 'why' },
      { path: 'a.arm', value: 'id: 3, name: arm, gear: 5', tag: 'CAD', note: 'from the model' },
      { path: 'b', value: '4', tag: 'CODE', note: 'source' },
    ])
    expect(parseParamNotes('')).toEqual([]); expect(parseParamNotes('x: 1 # just a comment')).toEqual([])
  })
})
