import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { BoxSpec, GameModule, RobotSpec } from '../src/engine/types'
import { OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../src/robots/offseason'

const FLOOR: BoxSpec = { center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 1 }

function emptyGame(walls: BoxSpec[] = []): GameModule {
  return {
    id: 'empty',
    field: () => ({ length: 200, width: 200, colliders: [FLOOR, ...walls], sensors: [] }),
    pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0, rollingDamping: 0, color: 0 }],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: () => [],
    hud: () => ({ title: 'empty' }),
  }
}

const ROBOT: RobotSpec = { half: OFFSEASON_HALF, start: { x: 0, y: 0, yaw: 0 }, script: [], drivetrain: OFFSEASON_DRIVETRAIN }

async function make(walls: BoxSpec[] = [], start = ROBOT.start): Promise<Engine> {
  return Engine.create({ game: emptyGame(walls), robot: { ...ROBOT, start }, seed: 1 })
}

function setAll(e: Engine, drive: number, steer = 0): void {
  for (const m of OFFSEASON_DRIVETRAIN.modules) { e.drivetrain!.setVolts(m.driveId, drive); e.drivetrain!.setVolts(m.steerId, steer) }
}

function pose(e: Engine): { x: number; y: number; yaw: number; vx: number; vy: number; omega: number } {
  const f = e.getFrame()
  const yaw = 2 * Math.atan2(f.robot[6], f.robot[3])
  return { x: f.robot[0], y: f.robot[1], yaw, vx: 0, vy: 0, omega: 0 }
}

describe('swerve drivetrain', () => {
  it('the gyro reads the start heading from the very first state, before any step (a robot that seeds its odometry then must not count a jump as a turn)', async () => {
    for (const yawDeg of [0, 45, -60, 90, 180]) {
      const e = await make([], { x: 3, y: 2, yaw: (yawDeg * Math.PI) / 180 })
      expect(e.drivetrain!.pigeonState().yawDeg, `start ${yawDeg}`).toBeCloseTo(yawDeg, 3)
      e.step(); e.step()
      const wrap = (d: number): number => ((d + 540) % 360) - 180
      expect(wrap(e.drivetrain!.pigeonState().yawDeg - yawDeg), `after two steps from ${yawDeg}`).toBeCloseTo(0, 2) // and it stays with the real heading
    }
  })

  it('sits still with no voltage', async () => {
    const e = await make()
    e.run(1)
    const p = pose(e)
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-6)
  })

  it('accelerates straight and reaches about the free speed at 12 V (4.39 m/s on the real module)', async () => {
    const e = await make()
    setAll(e, 12)
    let t43 = -1
    for (let i = 0; i < 4000; i++) {
      e.step()
      if (t43 < 0 && e.getFrame().robotSpeed > 4.0) t43 = e.time
    }
    const f = e.getFrame()
    expect(f.robotSpeed).toBeGreaterThan(4.2)
    expect(f.robotSpeed).toBeLessThan(4.7)
    expect(Math.abs(pose(e).y)).toBeLessThan(0.02) // no sideways drift
    expect(t43).toBeGreaterThan(0.3) // limited by traction and current, not instantaneous
    expect(t43).toBeLessThan(1.5)
  })

  it('strafes when the modules point left', async () => {
    const e = await make()
    OFFSEASON_DRIVETRAIN.modules.forEach((_, i) => e.drivetrain!.setAzimuth(i, Math.PI / 2))
    setAll(e, 12)
    e.run(2)
    const p = pose(e)
    expect(p.y).toBeGreaterThan(3)
    expect(Math.abs(p.x)).toBeLessThan(0.05)
  })

  it('spins in place with the modules tangent to the circle', async () => {
    const e = await make()
    // module azimuth for counterclockwise rotation: perpendicular to the radius vector
    OFFSEASON_DRIVETRAIN.modules.forEach((m, i) => e.drivetrain!.setAzimuth(i, Math.atan2(m.y, m.x) + Math.PI / 2))
    setAll(e, 6)
    e.run(2)
    const f = e.getFrame()
    const p = pose(e)
    expect(Math.hypot(p.x, p.y)).toBeLessThan(0.1) // stays put
    expect(f.robotSpeed).toBeLessThan(0.1)
    // yaw rate: about half the free speed over the module radius (4.4 / 2 / 0.41 = 5.4 rad/s)
    const rate = (() => { const a = pose(e).yaw; e.run(0.1); let d = pose(e).yaw - a; while (d < -Math.PI) d += 2 * Math.PI; return d / 0.1 })()
    expect(rate).toBeGreaterThan(4)
    expect(rate).toBeLessThan(7)
  })

  it('reports rotor states consistent with the motion (this is what the Talon sims read back)', async () => {
    const e = await make()
    setAll(e, 12)
    e.run(2)
    const dt = OFFSEASON_DRIVETRAIN
    const drive = e.drivetrain!.motorStates().find((m) => m.id === dt.modules[0].driveId)!
    // rotor velocity -> wheel -> ground speed (azimuth 0, so no coupling term)
    const wheelRps = drive.rotorVelocityRps / dt.driveRatio
    const ground = wheelRps * 2 * Math.PI * dt.wheelRadius
    expect(ground).toBeCloseTo(e.getFrame().robotSpeed, 0)
    // rotor position integrates the velocity
    expect(drive.rotorPositionRot).toBeGreaterThan(5)
    expect(e.drivetrain!.pigeonState().id).toBe(1)
  })

  it('steers: positive voltage turns the azimuth counterclockwise and reports the CANcoder angle', async () => {
    const e = await make()
    e.drivetrain!.setVolts(21, 3)
    e.run(0.2)
    const enc = e.drivetrain!.cancoderStates()[0]
    expect(enc.id).toBe(22)
    expect(enc.positionRot).toBeGreaterThan(0.01)
    const steerRotor = e.drivetrain!.motorStates().find((m) => m.id === 21)!
    expect(steerRotor.rotorPositionRot / OFFSEASON_DRIVETRAIN.steerRatio).toBeCloseTo(enc.positionRot, 6)
  })

  it('stops at a wall instead of driving through it', async () => {
    const wall: BoxSpec = { center: [3, 0, 0.5], half: [0.05, 5, 0.5], friction: 0.5, restitution: 0.5 }
    const e = await make([wall])
    setAll(e, 12)
    e.run(3)
    const p = pose(e)
    expect(p.x).toBeLessThan(3 - 0.05 - OFFSEASON_HALF[0] + 0.05) // bumper stays on this side of the wall
    expect(p.x).toBeGreaterThan(2)
  })

  it('wheels slipping against a wall settle below the free speed and stop when released', async () => {
    const wall: BoxSpec = { center: [3, 0, 0.5], half: [0.05, 5, 0.5], friction: 0.5, restitution: 0.5 }
    const e = await make([wall])
    setAll(e, 12)
    e.run(3)
    const rotor = (): number => e.drivetrain!.motorStates()[0].rotorVelocityRps
    expect(rotor()).toBeGreaterThan(60)
    expect(rotor()).toBeLessThan(100) // never past the motor's free speed (6000 rpm = 100 rps) because the wall holds it
    setAll(e, 0)
    e.run(0.5)
    expect(Math.abs(rotor())).toBeLessThan(1)
  })

  it('is deterministic and survives snapshots', async () => {
    const a = await make()
    setAll(a, 8)
    a.run(1)
    const snap = a.snapshot()
    a.run(1)
    const h = a.hash()
    a.restore(snap)
    a.run(1)
    expect(a.hash()).toBe(h)
    const b = await make()
    setAll(b, 8)
    b.run(2)
    expect(b.hash()).toBe(h)
  })
})
