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

interface Case { fuel: number; dt: number; iters?: number; settle?: number; tuning?: EngineConfig['tuning']; label?: string }

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
  const drive = (v: number): void => { for (const m of OFFSEASON.drivetrain.modules) { e.drivetrain!.setVolts(m.driveId, v); e.drivetrain!.setVolts(m.steerId, 0) } }
  drive(c.settle ? 0 : 6)
  const n = Math.round(simSeconds / c.dt)
  // warm-up: the first steps include JIT and settling of the pile (settle: let the pile come to rest first, robot still, then drive in)
  for (let i = 0; i < Math.round((c.settle ?? 0.5) / c.dt); i++) e.step()
  if (c.settle) drive(6)
  const t0 = performance.now()
  let awake = 0
  // timeline: wall cost per step in windows of 0.25 s of sim time, with the awake count, to find the worst moments (the average hides them)
  const win = Math.max(1, Math.round(0.25 / c.dt)); let wt = performance.now(); const windows: { t: number; ms: number; awake: number }[] = []
  for (let i = 0; i < n; i++) {
    e.step(); if (i % 200 === 0) awake += e.getFrame(false).awakeCount
    if ((i + 1) % win === 0) { const now = performance.now(); windows.push({ t: (i + 1) * c.dt, ms: (now - wt) / win, awake: e.getFrame(false).awakeCount }); wt = now }
  }
  if (process.env.CRUCIBLE_BENCH_TIMELINE) {
    fs.mkdirSync(path.resolve('runs'), { recursive: true })
    fs.appendFileSync(path.resolve('runs/bench-timeline.txt'), `fuel ${c.fuel} dt ${c.dt * 1000} ms\n` + windows.map((w) => `  t ${w.t.toFixed(2)}  ${w.ms.toFixed(3)} ms/step  awake ${w.awake}`).join('\n') + '\n')
  }
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
