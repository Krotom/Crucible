// Runs the real robot project (Gradle simulateJava with the bridge on) against the engine: slow, needs the robot repo and a JDK, so it
// only runs with RUN_SIM_TESTS=true. Drives the robot over a REBUILT BUMP and into the far wall and checks what its own odometry says.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { Nt4Raw } from '../src/engine/bridge/nt4raw'
import { decodeStruct } from '../src/renderer/src/lib/structs'
import { createRebuiltGame, BUMP, HUB_X, HUB_Y, FIELD_LENGTH } from '../src/games/rebuilt'
import { OFFSEASON } from '../src/robots/offseason'
import { RobotLauncher, resolveRobotDir, simulateCommand } from '../src/main/robot'
import type { GameEvent } from '../src/engine/types'

const run = process.env.RUN_SIM_TESTS === 'true'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(20) }
}

describe.skipIf(!run)('real robot code in the loop', () => {
  it('crosses a BUMP and hits the far wall; the robot odometry reacts', async () => {
    const dir = resolveRobotDir(path.resolve(__dirname, '..'))
    expect(dir).not.toBeNull()
    const lines: string[] = []
    const cmd = simulateCommand()
    const launcher = new RobotLauncher({ cwd: dir!, command: cmd.command, args: cmd.args, env: cmd.env, onLog: (l) => lines.push(l), onExit: () => {} })
    let session: BridgeSession | null = null
    const nt = new Nt4Raw('127.0.0.1', 5810)
    let odo: number[] | null = null
    const log: string[] = []
    const out = (s: string): void => { log.push(s); fs.writeFileSync(path.join(os.tmpdir(), 'crucible-real-robot.log'), log.join('\n') + '\n') }
    try {
      launcher.start()
      const events: GameEvent[] = []
      const base = createRebuiltGame({ preload: 0, neutralFuel: 0 })
      const game = { ...base, onEvent: (e: GameEvent, c: Parameters<typeof base.onEvent>[1]) => { if (e.type === 'robot-impact') events.push(e); return base.onEvent(e, c) } }
      const cy = HUB_Y + 0.597 + BUMP.width / 2
      const engine = await Engine.create({
        game,
        robot: { half: OFFSEASON.bumper, start: { x: 2.8, y: cy, yaw: 0 }, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls, alliance: 'blue', chassis: OFFSEASON.contact },
        seed: 7, solverIterations: 2,
      })
      session = new BridgeSession(engine, '127.0.0.1', { ws: 5811, nt: 5810 }, () => {}, OFFSEASON)
      session.start()
      nt.subscribeRaw('/AdvantageKit/RealOutputs/Swerve/Pose', (b) => { const v = decodeStruct('struct:Pose2d', b); if (v) odo = Array.from(v as ArrayLike<number>) })
      nt.start()
      await until(() => session!.status.connected && session!.status.frames > 100, 400_000, 'the robot to connect')
      out(`connected after ${lines.length} log lines; hello issues: ${JSON.stringify(session.status.helloIssues)}`)
      await wait(1500) // the pose seed
      session.setDs({ enabled: true, autonomous: false, test: false })

      const truth = (): { x: number; y: number; z: number; speed: number } => { const f = engine.getFrame(); return { x: f.robot[0], y: f.robot[1], z: f.robot[2] - OFFSEASON.bumper[2], speed: f.robotSpeed } }
      const sample = (tag: string): void => {
        const t = truth()
        const p = engine.drivetrain!.pigeonState()
        out(`${tag} t=${engine.time.toFixed(2)} truth=(${t.x.toFixed(2)},${t.y.toFixed(2)}) z=${t.z.toFixed(3)} v=${t.speed.toFixed(2)} pitch=${p.pitchDeg.toFixed(1)} roll=${p.rollDeg.toFixed(1)} odo=${odo ? `(${odo[0].toFixed(2)},${odo[1].toFixed(2)})` : 'none'} hits=${engine.getFrame().impacts.count}`)
      }

      // ---- over the BUMP at half speed (left stick forward is negative Y)
      session.setJoystick([0, -0.5, 0, 0, 0, 0], 0n, -1)
      let maxZ = 0
      let maxPitch = 0
      let minSpeedOnBump = 99
      const t0 = Date.now()
      while (truth().x < 6.8 && Date.now() - t0 < 30_000) {
        await wait(200)
        const t = truth()
        maxZ = Math.max(maxZ, t.z)
        maxPitch = Math.max(maxPitch, Math.abs(engine.drivetrain!.pigeonState().pitchDeg))
        if (t.x > HUB_X - 0.5 && t.x < HUB_X + 0.5) minSpeedOnBump = Math.min(minSpeedOnBump, t.speed)
        sample('bump')
      }
      const end = truth()
      const errBump = odo ? Math.hypot(odo[0] - end.x, odo[1] - end.y) : NaN
      out(`BUMP crossed: maxZ=${maxZ.toFixed(3)} maxPitch=${maxPitch.toFixed(1)} minSpeedOnBump=${minSpeedOnBump.toFixed(2)} odometry error=${errBump.toFixed(3)} m`)

      // ---- on to the far wall (past the red BUMP too), then keep pushing against it for 4 s
      const hitsBefore = events.length
      const t1 = Date.now()
      let wallAt = -1
      while (Date.now() - t1 < 40_000) {
        await wait(250)
        sample('run')
        if (wallAt < 0 && events.length > hitsBefore) wallAt = Date.now()
        if (wallAt > 0 && Date.now() - wallAt > 4000) break
      }
      const e2 = truth()
      const errWall = odo ? Math.hypot(odo[0] - e2.x, odo[1] - e2.y) : NaN
      out(`WALL: impacts=${events.length - hitsBefore} odometry error=${errWall.toFixed(3)} m, robot at x=${e2.x.toFixed(2)} of ${FIELD_LENGTH}`)
      out(JSON.stringify(events.slice(hitsBefore)))

      expect(maxZ).toBeGreaterThan(0.04)
      expect(maxPitch).toBeGreaterThan(3)
    } finally {
      session?.stop()
      nt.stop()
      await launcher.stop()
      fs.writeFileSync(path.join(os.tmpdir(), 'crucible-real-robot-gradle.log'), lines.slice(-200).join('\n'))
    }
  }, 900_000)
})
