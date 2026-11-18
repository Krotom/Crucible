import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { applyFaults, batteryVoltage, cleanBattery, cleanFaults, DEFAULT_BATTERY, NO_FAULTS, Noise } from '../src/engine/bridge/faults'
import { decodeFromApp, encodeToApp, type FromApp } from '../src/engine/bridge/frames'
import { MSG_FROM_APP, MSG_TO_APP } from '../src/engine/bridge/ws-transport'
import { buildSetup } from '../src/engine/setup'
import { OFFSEASON, OFFSEASON_DRIVETRAIN } from '../src/robots/offseason'
import { FakeRobotWs } from './helpers/fake-ws-robot'

const frame = (): FromApp => ({
  seq: 1n, simTime: 1, batteryVolts: 12,
  motors: [8, 20, 37].map((id) => ({ id, rotorPositionRot: 10, rotorVelocityRps: 5, rotorAccelRps2: 0 })),
  cancoders: [{ id: 22, positionRot: 0.25, velocityRps: 0, absolutePositionRot: 0.25 }],
  pigeons: [{ id: 1, yawDeg: 90, pitchDeg: 0, rollDeg: 0, yawRateDps: 3, pitchRateDps: 0, rollRateDps: 0, accelXg: 0, accelYg: 0, accelZg: 1 }],
})

describe('applying faults to the state the robot sees', () => {
  it('leaves the frame alone with no faults (the very same object)', () => {
    const f = frame(); expect(applyFaults(f, NO_FAULTS, new Noise(1))).toBe(f)
  })
  it('removes dropped devices of every kind and overrides the battery for a brownout, without touching the input', () => {
    const f = frame(), before = JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
    const o = applyFaults(f, { ...NO_FAULTS, dropIds: [8, 22, 1], brownoutVolts: 6.5 }, new Noise(1))
    expect(o.motors.map((m) => m.id)).toEqual([20, 37]); expect(o.cancoders).toEqual([]); expect(o.pigeons).toEqual([]); expect(o.batteryVolts).toBe(6.5)
    expect(JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(before)
  })
  it('adds noise of the right size, repeatably, and more of it at a higher level', () => {
    const spread = (level: number, seed: number): number => {
      const n = new Noise(seed); const xs: number[] = []
      for (let i = 0; i < 4000; i++) xs.push(applyFaults(frame(), { ...NO_FAULTS, noise: level }, n).motors[0].rotorPositionRot - 10)
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
    }
    expect(spread(1, 7)).toBeGreaterThan(0.0015); expect(spread(1, 7)).toBeLessThan(0.0025) // about 0.002 rot per level
    expect(spread(4, 7)).toBeGreaterThan(3 * spread(1, 7)); expect(spread(1, 7)).toBe(spread(1, 7)) // same seed, same noise
    expect(spread(1, 7)).not.toBe(spread(1, 8))
    const o = applyFaults(frame(), { ...NO_FAULTS, noise: 2 }, new Noise(3)); expect(o.pigeons[0].yawDeg).not.toBe(90); expect(Math.abs(o.pigeons[0].yawDeg - 90)).toBeLessThan(5)
  })
  it('cleans faults and battery settings from untrusted input', () => {
    expect(cleanFaults({ brownoutVolts: 99, latencyMs: -5, noise: 9, dropIds: [8, 8, -1, 1.5, 200, 37, NaN as never] })).toEqual({ brownoutVolts: 14, latencyMs: 0, noise: 5, dropIds: [8, 37] })
    expect(cleanFaults(undefined)).toEqual(NO_FAULTS); expect(cleanFaults({ brownoutVolts: null }).brownoutVolts).toBeNull(); expect(cleanFaults({ brownoutVolts: NaN }).brownoutVolts).toBe(6.8)
    expect(cleanBattery({ enabled: true, openVolts: 99, resistance: 0 })).toEqual({ enabled: true, openVolts: 14, resistance: 0.005 }); expect(cleanBattery(undefined)).toEqual(DEFAULT_BATTERY); expect(cleanBattery({ enabled: 1 as never }).enabled).toBe(false)
  })
  it('sags the battery with the load and never below 4 V', () => {
    expect(batteryVoltage(DEFAULT_BATTERY, 0)).toBeCloseTo(12.6); expect(batteryVoltage(DEFAULT_BATTERY, 100)).toBeCloseTo(10.8); expect(batteryVoltage(DEFAULT_BATTERY, 5000)).toBe(4); expect(batteryVoltage(DEFAULT_BATTERY, -50)).toBeCloseTo(12.6)
  })
})

describe('motor current in the engine', () => {
  it('is near zero when idle and large with full voltage on the drive, and falls as the robot gets up to speed', async () => {
    const e = await Engine.create(buildSetup({ mode: 'robot', game: 'test' }).config as never)
    for (let i = 0; i < 50; i++) e.step()
    expect(e.batteryAmps()).toBeLessThan(1)
    for (const m of OFFSEASON_DRIVETRAIN.modules) { e.setMotorVolts(m.driveId, 12) }
    e.step(); e.step(); const start = e.batteryAmps()
    for (let i = 0; i < 1500; i++) e.step()
    const later = e.batteryAmps()
    expect(start).toBeGreaterThan(60); expect(start).toBeLessThan(600); expect(later).toBeLessThan(start); expect(later).toBeGreaterThan(0)
    for (const mech of OFFSEASON.mechanisms) e.setMotorVolts(mech.id, 6)
    e.step(); expect(e.batteryAmps()).toBeGreaterThan(later)
    e.dispose()
  }, 60000)
})

// ---- the same, through a bridge session against a fake robot
const IDS = [...OFFSEASON_DRIVETRAIN.modules.flatMap((m) => [m.driveId, m.steerId]), ...OFFSEASON.mechanisms.map((m) => m.id)]
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(c: () => boolean, ms = 4000): Promise<void> { const t0 = Date.now(); while (!c()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await wait(5) } }
let robot: FakeRobotWs | null = null
let session: BridgeSession | null = null
afterEach(() => { session?.stop(); robot?.stop(); session = null; robot = null })

async function setup(): Promise<{ engine: Engine; send: (seq: number, t: number, volts?: Record<number, number>) => void; frames: () => FromApp[] }> {
  robot = new FakeRobotWs(); await robot.start()
  const engine = await Engine.create(buildSetup({ mode: 'robot', game: 'test' }).config as never)
  session = new BridgeSession(engine, '127.0.0.1', { ws: robot.port, nt: null }, () => {}, OFFSEASON)
  session.start(); await until(() => robot!.connections > 0 && session!.status.connected)
  const send = (seq: number, t: number, volts: Record<number, number> = {}): void => robot!.send(MSG_TO_APP, encodeToApp({ seq: BigInt(seq), simTime: t, batteryVolts: 12, flags: 1, motors: IDS.map((id) => ({ id, appliedVolts: volts[id] ?? 0, flags: 0 })) }))
  return { engine, send, frames: () => robot!.of(MSG_FROM_APP).map((b) => decodeFromApp(b)!) }
}

describe('faults and battery through a bridge session', () => {
  it('a dropped CAN device stops being reported, a brownout shows in the battery voltage, and both stop when switched off', async () => {
    const { send, frames } = await setup()
    send(1, 0.02); await until(() => frames().length >= 1)
    expect(frames().at(-1)!.motors.some((m) => m.id === 8)).toBe(true); expect(frames().at(-1)!.batteryVolts).toBe(12)
    session!.faults = cleanFaults({ dropIds: [8], brownoutVolts: 6.5 })
    send(2, 0.04); await until(() => frames().length >= 2)
    expect(frames().at(-1)!.motors.some((m) => m.id === 8)).toBe(false); expect(frames().at(-1)!.motors.length).toBeGreaterThan(5); expect(frames().at(-1)!.batteryVolts).toBeCloseTo(6.5)
    session!.faults = cleanFaults({}); send(3, 0.06); await until(() => frames().length >= 3)
    expect(frames().at(-1)!.motors.some((m) => m.id === 8)).toBe(true); expect(frames().at(-1)!.batteryVolts).toBe(12)
  })
  it('the battery model drops the voltage under load, and reports what the panel shows', async () => {
    const { send, frames } = await setup()
    session!.battery = cleanBattery({ enabled: true })
    send(1, 0.02); await until(() => frames().length >= 1); expect(frames().at(-1)!.batteryVolts).toBeGreaterThan(12.5)
    const drive: Record<number, number> = {}; for (const m of OFFSEASON_DRIVETRAIN.modules) drive[m.driveId] = 12
    for (let i = 2; i < 30; i++) { send(i, i * 0.02, drive); await wait(5) }
    await until(() => frames().length >= 29)
    const all = frames().map((f) => f.batteryVolts); const low = Math.min(...all); expect(low).toBeLessThan(11.5); expect(low).toBeGreaterThanOrEqual(4) // the sag peaks when the robot starts, then eases as it speeds up
    expect(all.at(-1)!).toBeGreaterThan(low); expect(session!.batteryReading.volts).toBeCloseTo(all.at(-1)!, 6); expect(session!.batteryReading.amps).toBeGreaterThan(0)
  })
  it('latency delays the answer by about that long (real-time mode)', async () => {
    const { send, frames } = await setup()
    session!.faults = cleanFaults({ latencyMs: 120 })
    const t0 = Date.now(); send(1, 0.02)
    await until(() => frames().length >= 1, 3000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110)
    session!.faults = cleanFaults({}); const t1 = Date.now(); send(2, 0.04); await until(() => frames().length >= 2); expect(Date.now() - t1).toBeLessThan(100)
  })
})
