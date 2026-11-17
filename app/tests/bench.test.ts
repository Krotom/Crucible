// Performance benchmark of the engine with a big FUEL pile: the robot drives through the neutral zone. Skipped unless CRUCIBLE_BENCH=1.
//   CRUCIBLE_BENCH=1 npx vitest run tests/bench.test.ts     (results are written to runs/bench.txt)
//   CRUCIBLE_BENCH_CASES='[{"fuel":408,"dt":0.001,"iters":4}]' overrides the cases
import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Engine } from '../src/engine/engine'
import type { EngineConfig } from '../src/engine/types'
import { createRebuiltGame } from '../src/games/rebuilt'
import { OFFSEASON } from '../src/robots/offseason'

interface Case { fuel: number; dt: number; iters?: number; tuning?: EngineConfig['tuning']; label?: string }

const DEFAULT: Case[] = [
  { fuel: 150, dt: 0.001, iters: 2 },
  { fuel: 408, dt: 0.001, iters: 2 },
  { fuel: 408, dt: 0.002, iters: 2 },
  { fuel: 408, dt: 0.005, iters: 2 },
]

async function run(c: Case, simSeconds = 6): Promise<string> {
  const e = await Engine.create({
    game: createRebuiltGame({ neutralFuel: c.fuel, preload: 0 }),
    robot: { half: OFFSEASON.bumper, start: { x: 5.6, y: 2.6, yaw: 0 }, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls, alliance: 'blue', chassis: OFFSEASON.contact },
    seed: 1, solverIterations: c.iters, dt: c.dt, tuning: c.tuning,
  })
  for (const m of OFFSEASON.drivetrain.modules) { e.drivetrain!.setVolts(m.driveId, 6); e.drivetrain!.setVolts(m.steerId, 0) }
  const n = Math.round(simSeconds / c.dt)
  // warm-up: the first steps include JIT and settling of the pile
  for (let i = 0; i < Math.round(0.5 / c.dt); i++) e.step()
  const t0 = performance.now()
  let awake = 0
  for (let i = 0; i < n; i++) { e.step(); if (i % 200 === 0) awake += e.getFrame(false).awakeCount }
  const ms = performance.now() - t0
  const f = e.getFrame(false)
  const perSim = ms / simSeconds
  return `${(c.label ?? '').padEnd(22)} fuel ${String(c.fuel).padStart(3)}  dt ${c.dt * 1000} ms  iters ${c.iters ?? 4}  ->  ${(ms / n).toFixed(3)} ms/step  ${(1000 / perSim).toFixed(2)}x real time  (avg awake ${(awake / Math.ceil(n / 200)).toFixed(0)}, pieces ${f.pieceCount}, robot x ${f.robot[0].toFixed(2)})`
}

describe.skipIf(!process.env.CRUCIBLE_BENCH)('engine benchmark', () => {
  it('measures the cost of a big FUEL pile', async () => {
    const cases: Case[] = process.env.CRUCIBLE_BENCH_CASES ? JSON.parse(process.env.CRUCIBLE_BENCH_CASES) : DEFAULT
    const lines: string[] = []
    for (const c of cases) lines.push(await run(c))
    fs.mkdirSync(path.resolve('runs'), { recursive: true })
    fs.writeFileSync(path.resolve('runs/bench.txt'), lines.join('\n') + '\n')
  }, 900_000)
})
