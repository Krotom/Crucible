import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { EngineTuning } from '../src/engine/types'
import { createRebuiltGame } from '../src/games/rebuilt'
import { OFFSEASON } from '../src/robots/offseason'

async function world(tuning: EngineTuning | undefined, fuel = 200, start = { x: 5.6, y: 2.6, yaw: 0 }): Promise<Engine> {
  return Engine.create({
    game: createRebuiltGame({ neutralFuel: fuel, preload: 0 }),
    robot: { half: OFFSEASON.bumper, start, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, alliance: 'blue', chassis: OFFSEASON.contact },
    seed: 2, solverIterations: 2, dt: 0.002, tuning,
  })
}

const drive = (e: Engine, volts: number): void => { for (const m of OFFSEASON.drivetrain.modules) { e.drivetrain!.setVolts(m.driveId, volts); e.drivetrain!.setVolts(m.steerId, 0) } }

function positions(e: Engine): [number, number][] {
  return e.pieceIds.map((id) => { const s = e.pieceState(id)!; return [s.position[0], s.position[1]] })
}

describe('pile manager', () => {
  it('starts a laid-out pile frozen, so it costs nothing until touched', async () => {
    const e = await world({ pile: true })
    e.run(0.2)
    expect(e.frozenCount).toBeGreaterThan(190)
    expect(e.getFrame(false).awakeCount).toBe(0)
  })

  it('thaws only what the robot reaches, and the pile freezes again behind it', async () => {
    const e = await world({ pile: true })
    const n = e.frozenCount
    drive(e, 5)
    e.run(1.0) // the robot has only passed a few pieces near its start
    const early = e.frozenCount
    expect(early).toBeGreaterThan(n * 0.7)
    e.run(2.0) // it reaches the near edge of the pile
    expect(e.frozenCount).toBeLessThan(early)
    expect(e.frozenCount).toBeGreaterThan(n * 0.3) // the far part of the pile never woke
    drive(e, 0)
    e.run(8)
    expect(e.frozenCount).toBeGreaterThan(n * 0.85) // settled again
  }, 60_000)

  it('moves FUEL about as much as the plain solver does when the robot plows through', async () => {
    const mean = async (tuning: EngineTuning | undefined): Promise<number> => {
      const e = await world(tuning, 150)
      const before = positions(e)
      drive(e, 5)
      e.run(5)
      drive(e, 0)
      e.run(3)
      const after = positions(e)
      return before.reduce((s, p, i) => s + Math.hypot(after[i][0] - p[0], after[i][1] - p[1]), 0) / before.length
    }
    const plain = await mean(undefined)
    const piled = await mean({ pile: true })
    expect(plain).toBeGreaterThan(0.3)
    expect(Math.abs(piled - plain) / plain).toBeLessThan(0.35)
  }, 120_000)

  it('repeats exactly and restores in the middle of a disturbance', async () => {
    const run = async (): Promise<string> => { const e = await world({ pile: true, ccd: 'fast' }); drive(e, 5); e.run(4); return e.hash() }
    expect(await run()).toBe(await run())
    const e = await world({ pile: true, ccd: 'fast' })
    drive(e, 5)
    e.run(3)
    const snap = e.snapshot()
    e.run(1.5)
    const a = e.hash()
    e.restore(snap)
    e.run(1.5)
    expect(e.hash()).toBe(a)
  }, 120_000)
})
