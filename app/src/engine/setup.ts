// What a simulation is made of, from the page's start request: the game, the robot (scripted or the real robot's definition), where it starts, the
// other robots and the physics settings. Shared by the live worker and the seed sweep, so both run exactly the same world.
import { blueAlly, botsToOthers, redCycler } from '../analysis/bots'
import { createRebuiltGame } from '../games/rebuilt'
import { createTestGame, TEST_ROBOT } from '../games/test'
import { OFFSEASON } from '../robots/offseason'
import { applyTune, type TuneParams } from './tuning'
import type { Engine } from './engine'
import type { ToWorker } from './protocol'
import type { GameModule } from './types'

export type InitParams = Extract<ToWorker, { type: 'init' }>
type EngineConfig = Parameters<typeof Engine.create>[0]

export interface Setup {
  config: Omit<EngineConfig, 'seed'>
  alliance: 'blue' | 'red'
  robotHalf: [number, number, number]
  othersHalf: [number, number, number][]
}

export function buildSetup(m: Pick<InitParams, 'mode' | 'game' | 'opponent' | 'stepDt' | 'alliance' | 'start'> & { tune?: TuneParams; /** a game loaded from a plugin file replaces the built-in ones */ gameModule?: GameModule }): Setup {
  // the definition with the tuned values laid over it: copies, so a tune never leaks into the next sim
  const def = applyTune({ drivetrain: OFFSEASON.drivetrain, balls: OFFSEASON.balls, contact: OFFSEASON.contact }, m.tune ?? {})
  const rebuilt = m.game === 'rebuilt'
  // REBUILT: the 360 FUEL of the CAD's neutral zone (the manual says 360 to 408). A pile of that size stays real time because resting FUEL is frozen (src/engine/pile.ts),
  // CCD runs only on fast pieces, 2 solver iterations, and a 2 ms step by default; see rules/REBUILT_RULES_EXTRACT.md section 7
  const game = m.gameModule ?? (rebuilt ? createRebuiltGame({ preload: OFFSEASON.balls?.preload ?? 0, }) : createTestGame())
  const field0 = game.field()
  const alliance = m.alliance ?? 'blue'
  let start: { x: number; y: number; yaw: number } = rebuilt ? { x: 1.6, y: 4.0, yaw: 0 } : { ...OFFSEASON.start }
  // red starts on the other side of the field facing the other way, unless the start was typed in
  if (alliance === 'red') start = { x: field0.length - start.x, y: field0.width - start.y, yaw: start.yaw + Math.PI }
  const ov = m.start
  if (ov) {
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
    if (ov.x !== undefined && Number.isFinite(ov.x)) start.x = clamp(ov.x, 0, field0.length)
    if (ov.y !== undefined && Number.isFinite(ov.y)) start.y = clamp(ov.y, 0, field0.width)
    if (ov.yawDeg !== undefined && Number.isFinite(ov.yawDeg)) start.yaw = (ov.yawDeg * Math.PI) / 180
  }
  // an opponent robot that holds still at the center line: something to push against and to be blocked by
  const others = m.opponent === 'both' ? botsToOthers([redCycler(), blueAlly()]) : m.opponent === 'ally' ? botsToOthers([blueAlly()]) : m.opponent === 'cycler' ? botsToOthers([redCycler()])
    : m.opponent === 'blocker' ? [{ name: 'opponent', alliance: 'red' as const, half: [0.43, 0.43, 0.12] as [number, number, number], mass: 55, start: { x: rebuilt ? 6.5 : 3, y: rebuilt ? 4.0 : 0, yaw: Math.PI } }] : []
  const robot = m.mode !== 'script'
    ? { half: OFFSEASON.bumper, start, script: [], drivetrain: def.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: def.balls, alliance, chassis: def.contact, others }
    : { ...TEST_ROBOT, start, alliance, others }
  return {
    // the physics step: larger is faster and coarser (REBUILT with 408 FUEL, measured before the field CAD: 1 ms about 0.9x, 2 ms 1.6x, 5 ms 4x real time while plowing the whole pile); in lockstep one exchange is one step
    config: { game, robot, solverIterations: rebuilt ? 2 : undefined, dt: m.stepDt ?? 0.002, tuning: rebuilt ? { pile: true, ccd: 'fast' } : undefined },
    alliance, robotHalf: robot.half as [number, number, number], othersHalf: others.map((o) => o.half as [number, number, number]),
  }
}
