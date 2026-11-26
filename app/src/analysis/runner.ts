// Runs a script against the robot code in lockstep and returns its report. Node only (it launches the robot project through Gradle); the part
// that needs no robot process, executeScript, works with any connected lockstep session.
import { Engine } from '../engine/engine'
import { BridgeSession } from '../engine/bridge/session'
import type { OtherRobotSpec, RobotSpec } from '../engine/types'
import { createRebuiltGame } from '../games/rebuilt'
import { createTestGame } from '../games/test'
import { OFFSEASON } from '../robots/offseason'
import { Recorder, type RunReport } from './recorder'
import { scheduleScript, validateScript, type RunScript } from './script'
import { botsToOthers } from './bots'

/** The engine a script runs in: the game, the OffSeason robot at its start pose, the other robots. */
export async function createWorld(script: RunScript): Promise<Engine> {
  const rebuilt = script.game === 'rebuilt'
  const preload = script.preload ?? OFFSEASON.balls?.preload ?? 0
  const game = rebuilt ? createRebuiltGame({ preload, neutralFuel: script.neutralFuel }) : createTestGame()
  const start = script.start ?? (rebuilt ? { x: 1.6, y: 4.0, yaw: 0 } : OFFSEASON.start)
  const balls = OFFSEASON.balls ? { ...OFFSEASON.balls, preload } : undefined
  const others: OtherRobotSpec[] = botsToOthers(script.bots ?? [])
  const robot: RobotSpec = {
    half: OFFSEASON.bumper, start, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls,
    alliance: 'blue', chassis: OFFSEASON.contact, others,
  }
  return Engine.create({ game, robot, seed: script.seed, solverIterations: rebuilt ? 2 : undefined, dt: script.step ?? 0.005, tuning: rebuilt ? { pile: true, ccd: 'fast' } : undefined })
}

/** Records and runs the script on an engine whose lockstep session is built but not started; resolves with the report once the run ends. */
export async function executeScript(engine: Engine, session: BridgeSession, script: RunScript, timeoutMs = 600_000): Promise<RunReport> {
  const problems = validateScript(script)
  if (problems.length) throw new Error(`script "${script.name}": ${problems.join('; ')}`)
  const rec = new Recorder(engine, { name: script.name, game: script.game, seed: script.seed, duration: script.duration, step: script.step ?? 0.005, preload: script.preload ?? OFFSEASON.balls?.preload ?? 0 })
  rec.attach()
  scheduleScript(session, script)
  for (let t = 0; t <= script.duration + 1e-9; t += 0.1) session.at(t, () => rec.sample())
  session.at(script.duration, () => { session.paused = true })
  session.start()
  const t0 = Date.now()
  while (!(session.paused && engine.time >= script.duration - 1e-9)) {
    if (Date.now() - t0 > timeoutMs) { rec.stop(); session.stop(); throw new Error(`script "${script.name}" did not finish in ${timeoutMs / 1000} s (reached ${engine.time.toFixed(2)} s)`) }
    await new Promise((r) => setTimeout(r, 10))
  }
  rec.stop()
  session.stop()
  return rec.report()
}

/** Anything that starts the robot project for a run and stops it afterwards (the default launches Gradle with the lockstep environment). */
export interface RobotProcess { start(): Promise<void>; stop(): Promise<void> }

export async function runOnRobot(script: RunScript, robot: RobotProcess, port = 5811): Promise<RunReport> {
  await robot.start()
  try {
    const engine = await createWorld(script)
    const session = new BridgeSession(engine, '127.0.0.1', { ws: port, nt: null }, () => {}, OFFSEASON, { dt: engine.dt, speed: 0 })
    return await executeScript(engine, session, script)
  } finally {
    await robot.stop()
  }
}
