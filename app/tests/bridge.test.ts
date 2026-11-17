// Contract tests: the bridge session against a fake robot that plays the robot side of docs/NT_CONTRACT.md on the bridge
// WebSocket (and a fake NetworkTables server for the component poses).
import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import {
  decodeFromApp, decodeToApp, encodeDs, encodeFromApp, encodeJoystick, encodePoseSeed, encodeToApp,
} from '../src/engine/bridge/frames'
import { MSG_DS, MSG_FROM_APP, MSG_HELLO, MSG_JOYSTICK, MSG_POSE_SEED, MSG_STATS, MSG_TO_APP } from '../src/engine/bridge/ws-transport'
import { OFFSEASON, OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../src/robots/offseason'
import { FakeNtServer } from './helpers/fake-nt-server'
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
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await wait(5) }
}

let robot: FakeRobotWs | null = null
let nt: FakeNtServer | null = null
let session: BridgeSession | null = null
afterEach(() => { session?.stop(); robot?.stop(); nt?.stop(); session = null; robot = null; nt = null })

async function setup(start = { x: 2, y: 1, yaw: 0.5 }): Promise<{ engine: Engine; fromApp: () => ReturnType<typeof decodeFromApp>[] }> {
  robot = new FakeRobotWs()
  nt = new FakeNtServer()
  await robot.start()
  await nt.start()
  const engine = await Engine.create({ game, robot: { half: OFFSEASON_HALF, start, script: [], drivetrain: OFFSEASON_DRIVETRAIN, mechanisms: OFFSEASON.mechanisms }, seed: 1 })
  session = new BridgeSession(engine, '127.0.0.1', { ws: robot.port, nt: nt.port }, () => {}, OFFSEASON)
  session.start()
  await until(() => robot!.connections > 0 && session!.status.connected)
  return { engine, fromApp: () => robot!.of(MSG_FROM_APP).map((b) => decodeFromApp(b)) }
}

function toApp(seq: number, simTime: number, volts: Record<number, number>, flags: Record<number, number> = {}): Uint8Array {
  return encodeToApp({ seq: BigInt(seq), simTime, batteryVolts: 12, flags: 1, motors: IDS.map((id) => ({ id, appliedVolts: volts[id] ?? 0, flags: flags[id] ?? 0 })) })
}

const sendToApp = (seq: number, simTime: number, volts: Record<number, number> = {}, flags: Record<number, number> = {}): void =>
  robot!.send(MSG_TO_APP, toApp(seq, simTime, volts, flags))

describe('frame codec', () => {
  it('round-trips ToApp and FromApp and rejects garbage', () => {
    const f = decodeToApp(toApp(7, 1.5, { 20: 3.25 }))!
    expect(f.seq).toBe(7n)
    expect(f.simTime).toBe(1.5)
    expect(f.motors.find((m) => m.id === 20)!.appliedVolts).toBe(3.25)
    expect(decodeToApp(new Uint8Array(10))).toBeNull()
    expect(decodeToApp(new Uint8Array(40))).toBeNull() // wrong magic

    const bytes = encodeFromApp({
      seq: 9n, simTime: 2, batteryVolts: 11.5,
      motors: [{ id: 20, rotorPositionRot: 1, rotorVelocityRps: 2, rotorAccelRps2: 3 }],
      cancoders: [{ id: 22, positionRot: 0.25, velocityRps: 0, absolutePositionRot: 0.25 }],
      pigeons: [{ id: 1, yawDeg: 90, pitchDeg: 0, rollDeg: 0, yawRateDps: 5, pitchRateDps: 0, rollRateDps: 0, accelXg: 0, accelYg: 0, accelZg: 1 }],
    })
    expect(bytes.length).toBe(40 + 28 + 28 + 76) // the sizes the Java codec uses
    const d = decodeFromApp(bytes)!
    expect(d.seq).toBe(9n)
    expect(d.motors[0].rotorVelocityRps).toBe(2)
    expect(d.pigeons[0].yawDeg).toBe(90)
  })

  it('writes the exact control-topic sizes the robot decodes', () => {
    expect(encodeDs({ counter: 1n, enabled: true, autonomous: false, test: false, estop: false, dsAttached: true, alliance: 1, station: 2, matchTime: 3 }).length).toBe(24)
    expect(encodeJoystick({ counter: 1n, axes: [0.5], buttons: 5n, pov: -1 }).length).toBe(72)
    expect(encodePoseSeed({ counter: 1n, x: 1, y: 2, yawRad: 3 }).length).toBe(32)
    // flag bits: enabled=1 autonomous=2 test=4 estop=8 dsAttached=16
    const v = new DataView(encodeDs({ counter: 1n, enabled: true, autonomous: true, test: false, estop: false, dsAttached: true, alliance: 1, station: 2, matchTime: 0 }).buffer)
    expect(v.getUint32(8, true)).toBe(1 | 2 | 16)
  })
})

describe('bridge session against a fake robot', () => {
  it('answers each ToApp frame with a FromApp frame carrying the same sequence number', async () => {
    const { fromApp } = await setup()
    for (let i = 0; i < 5; i++) sendToApp(i, 1 + i * 0.005)
    await until(() => fromApp().length >= 5)
    expect(fromApp().map((f) => Number(f!.seq))).toEqual([0, 1, 2, 3, 4])
    const last = fromApp()[4]!
    expect(last.motors.map((m) => m.id).sort((a, b) => a - b)).toEqual([...IDS].sort((a, b) => a - b))
    expect(last.cancoders.map((c) => c.id).sort()).toEqual([22, 25, 28, 31])
    expect(last.pigeons[0].id).toBe(1)
  })

  it('steps the physics by the robot time elapsed and returns the motion the voltages cause', async () => {
    const { engine, fromApp } = await setup()
    const volts = Object.fromEntries(OFFSEASON_DRIVETRAIN.modules.map((m) => [m.driveId, 12]))
    // 400 frames of 5 ms of robot time = 2 s, all drive motors at 12 V
    for (let i = 0; i < 400; i++) { sendToApp(i, 10 + i * 0.005, volts); if (i % 20 === 19) await wait(2) }
    await until(() => fromApp().length >= 400, 5000)
    expect(engine.steps).toBeGreaterThanOrEqual(1990)
    expect(engine.steps).toBeLessThanOrEqual(2000)
    const last = fromApp().at(-1)!
    const drive = last.motors.find((m) => m.id === 20)!
    expect(drive.rotorVelocityRps).toBeGreaterThan(40) // spinning near free speed (about 62 rps at the rotor)
    expect(last.pigeons[0].yawDeg).toBeCloseTo((0.5 * 180) / Math.PI, 3) // started at yaw 0.5 rad, driving straight
    expect(last.simTime).toBeCloseTo(engine.time, 9)
    // it moved along its heading
    const f = engine.getFrame()
    expect(Math.hypot(f.robot[0] - 2, f.robot[1] - 1)).toBeGreaterThan(4)
    expect(Math.atan2(f.robot[1] - 1, f.robot[0] - 2)).toBeCloseTo(0.5, 1)
  })

  it('does not run away when the robot jumps ahead in time', async () => {
    const { engine, fromApp } = await setup()
    sendToApp(0, 1)
    sendToApp(1, 100) // 99 s later
    await until(() => fromApp().length >= 2)
    expect(engine.time).toBeLessThanOrEqual(0.25 + 1e-9)
    expect(session!.status.skipped).toBe(1)
  })

  it('stands still while paused but keeps answering', async () => {
    const { engine, fromApp } = await setup()
    session!.paused = true
    const volts = Object.fromEntries(OFFSEASON_DRIVETRAIN.modules.map((m) => [m.driveId, 12]))
    for (let i = 0; i < 10; i++) sendToApp(i, 1 + i * 0.005, volts)
    await until(() => fromApp().length >= 10)
    expect(engine.steps).toBe(0)
  })

  it('moves mechanisms from their Talon voltages and zeroes them on the reset flag', async () => {
    const { engine, fromApp } = await setup()
    const HOOD = 40
    const hoodState = (): { pos: number; vel: number } => { const m = fromApp().at(-1)!.motors.find((x) => x.id === HOOD)!; return { pos: m.rotorPositionRot, vel: m.rotorVelocityRps } }
    for (let i = 0; i < 100; i++) sendToApp(i, 1 + i * 0.005, { [HOOD]: 12 })
    await until(() => fromApp().length >= 100)
    expect(hoodState().vel).toBeGreaterThan(100) // heading for the X44's free speed of about 130 rotor rps
    expect(hoodState().pos).toBeGreaterThan(10)
    const before = engine.mechanisms.get(HOOD)!.rotations
    expect(before).toBeGreaterThan(0.5)
    // the robot re-zeroes the hood: the flag stays up for a few frames, the app resets once on the rising edge
    for (let i = 100; i < 104; i++) sendToApp(i, 1 + i * 0.005, { [HOOD]: 12 }, { [HOOD]: 4 })
    await until(() => fromApp().length >= 104)
    expect(engine.mechanisms.get(HOOD)!.rotations).toBeLessThan(before / 3) // zeroed at the first flagged frame, then 3 more frames of drive
    expect(engine.mechanisms.get(HOOD)!.rotations).toBeGreaterThan(0)
  })

  it('reports mechanism states ahead by the lead, from the measured round trip', async () => {
    const { engine, fromApp } = await setup()
    const HOOD = 40
    session!.autoLead = false
    session!.lead = 0
    for (let i = 0; i < 40; i++) sendToApp(i, 1 + i * 0.005, { [HOOD]: 12 })
    await until(() => fromApp().length >= 40)
    const now = fromApp().at(-1)!.motors.find((m) => m.id === HOOD)!.rotorPositionRot
    session!.lead = 0.02
    sendToApp(40, 1 + 40 * 0.005, { [HOOD]: 12 })
    await until(() => fromApp().length >= 41)
    const ahead = fromApp().at(-1)!.motors.find((m) => m.id === HOOD)!
    expect(ahead.rotorPositionRot).toBeGreaterThan(now + 1) // 20 ms ahead at 100+ rps
    // the physics itself was not moved by the projection: one more real step matches
    expect(engine.mechanisms.get(HOOD)!.rotations * 16.40625).toBeLessThan(ahead.rotorPositionRot)

    // the automatic lead follows the robot's round-trip report
    session!.autoLead = true
    const stats = new Uint8Array(24)
    new DataView(stats.buffer).setFloat64(0, 4500, true)
    robot!.send(MSG_STATS, stats)
    await until(() => session!.rtt > 0)
    expect(session!.rtt).toBeCloseTo(0.0045, 6)
    expect(session!.lead).toBeCloseTo(0.0045, 6)
  })

  it('checks the robot Hello against the definition and keeps the robot component poses', async () => {
    await setup()
    const hello = JSON.stringify({ protocol: 0, devices: [{ type: 'talonfx', id: 20 }], mechanisms: [] })
    robot!.send(MSG_HELLO, new TextEncoder().encode(hello))
    const poses = new Float64Array([1, 2, 3, 1, 0, 0, 0])
    await until(() => nt!.subscribed.has('/AdvantageKit/RealOutputs/Mechanism3d/Components'))
    nt!.sendRaw('/AdvantageKit/RealOutputs/Mechanism3d/Components', new Uint8Array(poses.buffer), 0)
    await until(() => session!.status.helloIssues.length > 0 && session!.status.components !== null)
    expect(session!.status.helloIssues.join(' ')).toContain('does not register')
    expect(Array.from(session!.status.components!)).toEqual([1, 2, 3, 1, 0, 0, 0])
  })

  it('publishes DS, joystick and pose seed to the robot', async () => {
    await setup({ x: 3, y: 4, yaw: 1 })
    for (let i = 0; i < 25; i++) sendToApp(i, 1 + i * 0.005)
    session!.setDs({ enabled: true, autonomous: false })
    session!.setJoystick([0.1, -0.9, 0, 0, 0.3, 0], 0b101n, 90)
    await until(() => robot!.of(MSG_JOYSTICK).length >= 2 && robot!.of(MSG_POSE_SEED).length >= 1)
    const ds = robot!.of(MSG_DS).at(-1)!
    expect(new DataView(ds.buffer, ds.byteOffset).getUint32(8, true) & 1).toBe(1) // enabled
    const joy = robot!.of(MSG_JOYSTICK).at(-1)!
    const jv = new DataView(joy.buffer, joy.byteOffset)
    expect(jv.getFloat64(8 + 8, true)).toBeCloseTo(-0.9)
    expect(jv.getBigUint64(56, true)).toBe(5n)
    expect(jv.getInt16(64, true)).toBe(90)
    const seed = robot!.of(MSG_POSE_SEED).at(-1)!
    const sv = new DataView(seed.buffer, seed.byteOffset)
    expect(sv.getFloat64(8, true)).toBeCloseTo(3)
    expect(sv.getFloat64(16, true)).toBeCloseTo(4)
    expect(sv.getFloat64(24, true)).toBeCloseTo(1)
  })
})
