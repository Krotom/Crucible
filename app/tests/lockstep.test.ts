// Lockstep (Mode B) from the app's side, against a fake robot that answers Step with ToApp like the real one (docs/NT_CONTRACT.md section 14).
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { decodeFromApp, encodeToApp } from '../src/engine/bridge/frames'
import { MSG_DS, MSG_FROM_APP, MSG_HELLO, MSG_POSE_SEED, MSG_STEP, MSG_TO_APP } from '../src/engine/bridge/ws-transport'
import { OFFSEASON, OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../src/robots/offseason'
import { FakeRobotWs } from './helpers/fake-ws-robot'

const IDS = [...OFFSEASON_DRIVETRAIN.modules.flatMap((m) => [m.driveId, m.steerId]), ...OFFSEASON.mechanisms.map((m) => m.id)]

const game = {
  id: 'empty',
  field: () => ({ length: 200, width: 200, colliders: [{ center: [0, 0, -0.1] as [number, number, number], half: [100, 100, 0.1] as [number, number, number], friction: 0.8, restitution: 1 }], sensors: [] }),
  pieces: () => [],
  initialLayout: () => [],
  matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
  onEvent: () => [],
  hud: () => ({ title: 'empty' }),
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await wait(2) }
}

let robot: FakeRobotWs | null = null
let session: BridgeSession | null = null
afterEach(() => { session?.stop(); robot?.stop(); session = null; robot = null })

/** A fake lockstep robot: says hello, and answers Step(seq, dt) with ToApp(seq) after running `volts(seq)` as the drive voltage. */
async function setup(opts: { dt: number; speed?: number; hello?: string; volts?: (seq: number) => number }): Promise<{ engine: Engine; steps: () => number[] }> {
  robot = new FakeRobotWs()
  await robot.start()
  const hello = opts.hello ?? JSON.stringify({ protocol: 0, name: 'OffSeason', modes: ['lockstep'], devices: [], mechanisms: [] })
  robot.onConnect = () => robot!.send(MSG_HELLO, new TextEncoder().encode(hello))
  const stepsSeen: number[] = []
  robot.onMessage = (m) => {
    if (m.type !== MSG_STEP) return
    const v = new DataView(m.body.buffer, m.body.byteOffset, m.body.byteLength)
    const seq = Number(v.getBigUint64(0, true))
    const dt = v.getFloat64(8, true)
    stepsSeen.push(seq)
    const volts = opts.volts?.(seq) ?? 0
    robot!.send(MSG_TO_APP, encodeToApp({
      seq: BigInt(seq), simTime: seq * dt, batteryVolts: 12, flags: 1,
      motors: IDS.map((id) => ({ id, appliedVolts: OFFSEASON_DRIVETRAIN.modules.some((x) => x.driveId === id) ? volts : 0, flags: 0 })),
    }))
  }
  const engine = await Engine.create({ game, robot: { half: OFFSEASON_HALF, start: { x: 2, y: 1, yaw: 0 }, script: [], drivetrain: OFFSEASON_DRIVETRAIN, mechanisms: OFFSEASON.mechanisms }, seed: 1, dt: opts.dt })
  session = new BridgeSession(engine, '127.0.0.1', { ws: robot.port, nt: null }, () => {}, OFFSEASON, { dt: opts.dt, speed: opts.speed ?? 0 })
  return { engine, steps: () => stepsSeen }
}

describe('lockstep session against a fake robot', () => {
  it('starts after the robot says lockstep: seed, the starting state as FromApp 0, then Step 1, 2, 3', async () => {
    const { engine, steps } = await setup({ dt: 0.005 })
    session!.at(0.1, () => session!.paused = true)
    session!.start()
    await until(() => steps().length >= 20)
    await wait(50)
    expect(steps().slice(0, 4)).toEqual([1, 2, 3, 4])
    expect(robot!.of(MSG_POSE_SEED).length).toBe(1)
    const froms = robot!.of(MSG_FROM_APP).map((b) => decodeFromApp(b)!)
    expect(Number(froms[0].seq)).toBe(0)
    expect(froms.slice(1, 5).map((f) => Number(f.seq))).toEqual([1, 2, 3, 4])
    expect(engine.time).toBeCloseTo(steps().length * 0.005, 9) // one dt of physics per exchange, exactly
  })

  it('flags a robot that is not in lockstep and sends no steps', async () => {
    const { steps } = await setup({ dt: 0.005, hello: JSON.stringify({ protocol: 0, name: 'OffSeason', modes: ['realtime'], devices: [], mechanisms: [] }) })
    session!.start()
    await until(() => session!.status.helloIssues.length > 0)
    await wait(50)
    expect(session!.status.helloIssues.join(' ')).toContain('lockstep')
    expect(steps().length).toBe(0)
  })

  it('runs timed actions before the step that crosses their time, in order', async () => {
    const { engine, steps } = await setup({ dt: 0.005 })
    const seen: string[] = []
    session!.at(0.02, () => seen.push(`b@${engine.time.toFixed(3)}`))
    session!.at(0.01, () => seen.push(`a@${engine.time.toFixed(3)}`))
    session!.at(0.05, () => { seen.push(`c@${engine.time.toFixed(3)}`); session!.paused = true })
    session!.start()
    await until(() => seen.length === 3)
    await wait(30)
    expect(seen).toEqual(['a@0.010', 'b@0.020', 'c@0.050'])
    expect(steps().length).toBe(10) // 0.05 s at 5 ms, then paused
  })

  it('pauses (no steps, the robot clock stands still) and resumes', async () => {
    const { steps } = await setup({ dt: 0.005 })
    session!.at(0.025, () => { session!.paused = true })
    session!.start()
    await until(() => session!.paused)
    await wait(60)
    const n = steps().length
    expect(n).toBe(5)
    await wait(60)
    expect(steps().length).toBe(n)
    session!.paused = false
    await until(() => steps().length > n + 3)
  })

  it('repeats exactly: the same robot script gives the same physics state', async () => {
    const hashes: string[] = []
    for (let r = 0; r < 2; r++) {
      const { engine, steps } = await setup({ dt: 0.005, volts: (s) => (s < 100 ? 6 : s < 200 ? -3 : 9) })
      session!.at(1.0, () => { session!.paused = true })
      session!.start()
      await until(() => session!.paused, 10_000)
      await wait(20)
      expect(steps().length).toBe(200)
      hashes.push(engine.hash())
      session!.stop(); robot!.stop(); session = null; robot = null
    }
    expect(hashes[0]).toBe(hashes[1])
  })

  it('paces to the requested speed and goes as fast as it can at 0', async () => {
    const { engine } = await setup({ dt: 0.005, speed: 1 })
    session!.at(0.3, () => { session!.paused = true })
    const t0 = performance.now()
    session!.start()
    await until(() => session!.paused, 5000)
    const slow = performance.now() - t0
    expect(engine.time).toBeCloseTo(0.3, 6)
    expect(slow).toBeGreaterThan(250) // 0.3 s of sim at 1x
    session!.stop(); robot!.stop()

    const fast = await setup({ dt: 0.005, speed: 0 })
    session!.at(0.3, () => { session!.paused = true })
    const t1 = performance.now()
    session!.start()
    await until(() => session!.paused, 5000)
    expect(performance.now() - t1).toBeLessThan(slow)
    expect(fast.engine.time).toBeCloseTo(0.3, 6)
  })

  it('sends Driver Station controls between exchanges, tied to the sim clock', async () => {
    const { steps } = await setup({ dt: 0.005 })
    session!.at(0.02, () => session!.setDs({ enabled: true, autonomous: false, test: false }))
    session!.at(0.05, () => { session!.paused = true })
    session!.start()
    await until(() => session!.paused)
    await wait(30)
    const order = robot!.messages.map((m) => (m.type === MSG_STEP ? 'step' : m.type === MSG_DS ? 'ds' : null)).filter((x) => x !== null)
    const dsAt = order.indexOf('ds', 1) // the first DS is the connect handshake
    expect(order.slice(0, dsAt).filter((x) => x === 'step').length).toBe(4) // after 4 steps = 0.02 s, before step 5
    expect(steps().length).toBe(10)
  })
})
