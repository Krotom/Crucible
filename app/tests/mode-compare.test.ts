// Mode A (the Phoenix sim's real Talon control loop, real time) against Mode B (the Java emulation, lockstep) on the real robot project:
// press the intake button and compare how the intake slide (MotionMagic position) and the roller (voltage) move. Slow; RUN_SIM_TESTS=true.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { createTestGame } from '../src/games/test'
import { OFFSEASON } from '../src/robots/offseason'
import { RobotLauncher, resolveRobotDir, simulateCommand } from '../src/main/robot'

const run = process.env.RUN_SIM_TESTS === 'true'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const DRIVER = 33
const ROLLER = 35

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(5) }
}

async function portFree(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const busy = await new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
    if (!busy) return
    await wait(100)
  }
  throw new Error('port stays busy')
}

interface Sample { t: number; pos: number; roller: number }

/** Presses A (intaking) at PRESS seconds of engine time and records the intake slide and roller for 2.5 s. */
async function record(lockstep: boolean): Promise<Sample[]> {
  const PRESS = 1.8
  const dir = resolveRobotDir(path.resolve(__dirname, '..'))
  const cmd = simulateCommand(lockstep)
  const lines: string[] = []
  const launcher = new RobotLauncher({ cwd: dir!, command: cmd.command, args: cmd.args, env: cmd.env, onLog: (l) => lines.push(l), onExit: () => {} })
  let session: BridgeSession | null = null
  const samples: Sample[] = []
  try {
    await portFree(5811)
    launcher.start()
    const engine = await Engine.create({
      game: createTestGame(),
      robot: { half: OFFSEASON.bumper, start: { x: 2.6, y: 2.6, yaw: 0 }, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls, alliance: 'blue', chassis: OFFSEASON.contact },
      seed: 5,
    })
    session = new BridgeSession(engine, '127.0.0.1', { ws: 5811, nt: null }, () => {}, OFFSEASON, lockstep ? { dt: 0.001, speed: 0 } : null)
    const sample = (): void => {
      const d = engine.mechanisms.get(DRIVER)!
      const r = engine.mechanisms.get(ROLLER)!
      samples.push({ t: engine.time, pos: d.rotations, roller: r.rps })
    }
    if (lockstep) {
      session.at(0.3, () => session!.setDs({ enabled: true, autonomous: false, test: false }))
      session.at(PRESS, () => session!.setJoystick([0, 0, 0, 0, 0, 0], 1n, -1))
      for (let t = PRESS - 0.2; t <= PRESS + 2.5; t += 0.01) session.at(t, sample)
    }
    session.start()
    await until(() => session!.status.connected && session!.status.frames > 50, 200_000, 'the robot to connect')
    if (!lockstep) {
      await wait(1500)
      session.setDs({ enabled: true, autonomous: false, test: false })
      const enabledAt = engine.time
      await until(() => engine.time >= enabledAt + (PRESS - 0.3) - 0.2, 20_000, 'sim time')
      let pressedAt = -1
      while (pressedAt < 0 || engine.time < pressedAt + 2.5) {
        if (pressedAt < 0 && engine.time >= enabledAt + (PRESS - 0.3)) { session.setJoystick([0, 0, 0, 0, 0, 0], 1n, -1); pressedAt = engine.time }
        sample()
        await wait(10)
      }
      for (const x of samples) x.t = x.t - pressedAt + PRESS // align the press at PRESS, as in lockstep
    } else await until(() => engine.time >= PRESS + 2.52, 200_000, 'the run')
    return samples
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), `crucible-compare-${lockstep ? 'B' : 'A'}-robot.log`), lines.slice(-100).join('\n'))
    session?.stop()
    await launcher.stop()
    await portFree(5811)
  }
}

/** Time after the press when the signal first reaches `frac` of its final value (null if it never moves). */
function timeTo(s: Sample[], pick: (x: Sample) => number, frac: number): number | null {
  const final = pick(s[s.length - 1])
  const start = pick(s.find((x) => x.t > 1.7) ?? s[0])
  if (Math.abs(final - start) < 1e-6) return null
  const hit = s.find((x) => x.t > 1.8 && (pick(x) - start) / (final - start) >= frac)
  return hit ? hit.t - 1.8 : null
}

describe.skipIf(!run)('Mode A against Mode B on the real robot', () => {
  it('the intake slide and roller move the same way', async () => {
    const a = await record(false)
    const b = await record(true)
    const lines: string[] = []
    const stat = (name: string, s: Sample[]): void => {
      lines.push(`${name}: slide final ${s[s.length - 1].pos.toFixed(3)} rot, 50% ${timeTo(s, (x) => x.pos, 0.5)?.toFixed(3)} s, 90% ${timeTo(s, (x) => x.pos, 0.9)?.toFixed(3)} s; roller final ${s[s.length - 1].roller.toFixed(2)} rps, 90% ${timeTo(s, (x) => x.roller, 0.9)?.toFixed(3)} s`)
    }
    stat('Mode A (Phoenix sim)', a)
    stat('Mode B (emulation)  ', b)
    // curves every 100 ms after the press
    for (let k = 0; k <= 25; k += 2) {
      const at = (s: Sample[]): Sample => s.reduce((best, x) => (Math.abs(x.t - (1.8 + k / 10)) < Math.abs(best.t - (1.8 + k / 10)) ? x : best))
      lines.push(`+${(k / 10).toFixed(1)} s  slide A ${at(a).pos.toFixed(3)}  B ${at(b).pos.toFixed(3)}   roller A ${at(a).roller.toFixed(1)}  B ${at(b).roller.toFixed(1)}`)
    }
    fs.writeFileSync(path.join(os.tmpdir(), 'crucible-compare.log'), lines.join('\n') + '\n')
    const ta = timeTo(a, (x) => x.pos, 0.9)
    const tb = timeTo(b, (x) => x.pos, 0.9)
    expect(ta).not.toBeNull()
    expect(tb).not.toBeNull()
    expect(Math.abs(ta! - tb!)).toBeLessThan(0.15)
  }, 900_000)
})
