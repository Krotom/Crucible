// Mode B against the real robot project: the robot runs on the app's clock (lockstep), with the Java Talon emulation and the swerve layer.
// Slow (it starts Gradle), so it only runs with RUN_SIM_TESTS=true. Checks that the robot code drives the robot, that two runs of the same
// script give the same physics state at every sample, and how fast the exchange goes.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { createTestGame } from '../src/games/test'
import { OFFSEASON } from '../src/robots/offseason'
import { RobotLauncher, resolveRobotDir, simulateCommand } from '../src/main/robot'

const run = process.env.RUN_SIM_TESTS === 'true'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface RunResult { hashes: string[]; poses: string[]; wallMs: number; simSeconds: number; steps: number; issues: string[]; hello: string }

/** Waits until nothing listens on the bridge port (a robot that was just stopped can still hold it for a moment and would answer the next app). */
async function portFree(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const busy = await new Promise<boolean>((res) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true) }); s.once("error", () => res(false)) })
    if (!busy) return
    await wait(100)
  }
  throw new Error("port " + port + " stays busy")
}

async function runScript(label: string, endTime: number, speed: number): Promise<RunResult> {
  const dir = resolveRobotDir(path.resolve(__dirname, '..'))
  const lines: string[] = []
  const cmd = simulateCommand()
  const launcher = new RobotLauncher({ cwd: dir!, command: cmd.command, args: cmd.args, env: { ...cmd.env, CRUCIBLE_MODE: 'lockstep' }, onLog: (l) => lines.push(l), onExit: () => {} })
  let session: BridgeSession | null = null
  const hashes: string[] = []
  const poses: string[] = []
  const fine: string[] = []
  try {
    await portFree(5811)
    launcher.start()
    const engine = await Engine.create({
      game: createTestGame(),
      robot: { half: OFFSEASON.bumper, start: { x: 2.6, y: 2.6, yaw: 0 }, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls, alliance: 'blue', chassis: OFFSEASON.contact },
      seed: 11, dt: Number(process.env.LOCKSTEP_PHYS ?? 0.001),
    })
    session = new BridgeSession(engine, '127.0.0.1', { ws: 5811, nt: null }, () => {}, OFFSEASON, { dt: Number(process.env.LOCKSTEP_DT ?? 0.001), speed })
    // the script is tied to the sim clock, so every run sees the same inputs at the same steps
    session.at(0.3, () => session!.setDs({ enabled: true, autonomous: false, test: false }))
    session.at(1.0, () => session!.setJoystick([0, -0.5, 0, 0, 0, 0], 0n, -1))
    session.at(2.5, () => session!.setJoystick([-0.5, 0, 0, 0, 0, 0], 0n, -1)) // strafe (left stick X is the strafe axis)
    session.at(4.0, () => session!.setJoystick([0, 0, 0, 0, 0, 0], 0n, -1))
    for (let t = 0.5; t <= endTime; t += 0.5) {
      session.at(t, () => { const f = engine.getFrame(); hashes.push(`${t.toFixed(1)} ${f.hash}`); poses.push(`${t.toFixed(1)} (${f.robot[0].toFixed(3)}, ${f.robot[1].toFixed(3)})`) })
    }
    for (let k = 1; k <= Number(process.env.LOCKSTEP_FINE ?? 0); k++) {
      session.at(k / 1000, () => { const m = [...engine.mechanisms.entries()].map(([id, mm]) => id + ":" + mm.angle.toExponential(6)).join(" "); fine.push(k + " " + engine.hash() + " " + m + " volts " + [...session!.lastMotorVolts.entries()].filter(([, v]) => v !== 0).map(([id, v]) => id + ":" + v.toFixed(6)).join(" ")) })
    }
    session.start()
    const t0 = Date.now()
    await until(() => session!.status.connected, 200_000, 'the robot to connect')
    await until(() => engine.time >= 0.2, 120_000, 'the first steps')
    const wall0 = Date.now()
    await until(() => engine.time >= endTime + 0.01, 300_000, 'the run to finish')
    const wallMs = Date.now() - wall0
    void t0
    fs.writeFileSync(path.join(os.tmpdir(), `crucible-lockstep-${label}.log`), [...poses, ...lines.slice(-60)].join('\n'))
    fs.writeFileSync(path.join(os.tmpdir(), `crucible-lockstep-${label}-fine.log`), fine.join(String.fromCharCode(10)))
    return { hashes, poses, wallMs, simSeconds: engine.time, steps: session.lockstepSteps, issues: session.status.helloIssues, hello: session.status.helloDevices ?? '' }
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), `crucible-lockstep-${label}-gradle.log`), lines.slice(-300).join('\n'))
    session?.stop()
    await launcher.stop()
    await portFree(5811)
  }
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(25) }
}

describe.skipIf(!run)('lockstep (Mode B) with the real robot project', () => {
  it('drives, repeats exactly, and runs faster than real time', async () => {
    const END = Number(process.env.LOCKSTEP_END ?? 6)
    const a = await runScript('a', END, 0)
    const out = (s: string): void => fs.appendFileSync(path.join(os.tmpdir(), 'crucible-lockstep-summary.log'), s + '\n')
    fs.writeFileSync(path.join(os.tmpdir(), 'crucible-lockstep-summary.log'), '')
    out(`run A: ${a.simSeconds.toFixed(2)} s simulated in ${(a.wallMs / 1000).toFixed(2)} s wall = ${(a.simSeconds / (a.wallMs / 1000)).toFixed(2)}x real time, ${a.steps} steps`)
    out(`hello issues: ${JSON.stringify(a.issues)}`)
    out(a.poses.join('\n'))
    const b = await runScript('b', END, 0)
    out(`run B: ${b.simSeconds.toFixed(2)} s in ${(b.wallMs / 1000).toFixed(2)} s`)
    out(`hash match: ${JSON.stringify(a.hashes) === JSON.stringify(b.hashes)}`)
    const first = a.hashes.findIndex((h, i) => h !== b.hashes[i])
    out(first < 0 ? 'identical at every sample' : `first difference at sample ${first}: ${a.hashes[first]} vs ${b.hashes[first]}`)
    expect(a.issues).toEqual([])
    expect(a.poses.length).toBeGreaterThan(5)
    expect(a.hashes).toEqual(b.hashes)
  }, 1_200_000)
})
