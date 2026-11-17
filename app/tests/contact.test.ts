import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { BoxSpec, GameEvent, GameModule, OtherRobotSpec, RobotSpec } from '../src/engine/types'
import { bumpHeight, BUMP, createRebuiltGame, HUB_X, HUB_Y } from '../src/games/rebuilt'
import { OFFSEASON, OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../src/robots/offseason'

const FLOOR: BoxSpec = { center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 1 }
const WALL = (x: number): BoxSpec => ({ center: [x + 0.1, 0, 1], half: [0.1, 20, 1], friction: 0.8, restitution: 1 })

function game(walls: BoxSpec[], events: GameEvent[], terrain?: (x: number, y: number) => number): GameModule {
  return {
    id: 'contact',
    field: () => ({ length: 200, width: 200, colliders: [FLOOR, ...walls], sensors: [] }),
    pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0, rollingDamping: 0, color: 0 }],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: (e) => { events.push(e); return [] },
    hud: () => ({ title: 'contact' }),
    terrain,
  }
}

interface Opts { walls?: BoxSpec[]; terrain?: (x: number, y: number) => number; others?: OtherRobotSpec[]; start?: { x: number; y: number; yaw: number } }

async function make(o: Opts = {}): Promise<{ e: Engine; events: GameEvent[] }> {
  const events: GameEvent[] = []
  const robot: RobotSpec = {
    half: OFFSEASON_HALF, start: o.start ?? { x: 0, y: 0, yaw: 0 }, script: [], drivetrain: OFFSEASON_DRIVETRAIN,
    chassis: OFFSEASON.contact, others: o.others,
  }
  const e = await Engine.create({ game: game(o.walls ?? [], events, o.terrain), robot, seed: 1 })
  return { e, events }
}

function drive(e: Engine, volts: number): void {
  for (const m of OFFSEASON_DRIVETRAIN.modules) { e.drivetrain!.setVolts(m.driveId, volts); e.drivetrain!.setVolts(m.steerId, 0) }
}

const other = (x: number, o: Partial<OtherRobotSpec> = {}): OtherRobotSpec => ({
  name: 'other', alliance: 'red', half: [0.43, 0.43, 0.12], mass: 55, start: { x, y: 0, yaw: Math.PI }, ...o,
})

describe('chassis contact', () => {
  it('stops at a wall, reports the impact with the speed it lost, and the accelerometer feels it', async () => {
    const { e, events } = await make({ walls: [WALL(3.0)] })
    drive(e, 12)
    let minAx = 0
    let speedAtHit = 0
    for (let i = 0; i < 3000; i++) {
      e.step()
      minAx = Math.min(minAx, e.drivetrain!.pigeonState().accelXg)
      if (e.time > 0.5 && speedAtHit === 0 && e.getFrame().robot[0] > 3.0 - OFFSEASON_HALF[0] - 0.02) speedAtHit = e.getFrame().robotSpeed
    }
    const f = e.getFrame()
    expect(f.robot[0]).toBeGreaterThan(3.0 - OFFSEASON_HALF[0] - 0.05) // against the wall
    expect(f.robot[0]).toBeLessThan(3.0 - OFFSEASON_HALF[0] + 0.01) // not through it
    expect(f.robotSpeed).toBeLessThan(0.1)
    const hits = events.filter((x) => x.type === 'robot-impact')
    expect(hits.length).toBeGreaterThanOrEqual(1) // the bumpers rebound a little and the drive pushes it back in
    if (hits[0].type === 'robot-impact') {
      expect(hits[0].against).toBe('field')
      expect(hits[0].speed).toBeGreaterThan(2)
      expect(hits[0].speed).toBeLessThan(7) // the approach speed plus the rebound
    }
    expect(minAx).toBeLessThan(-1) // a deceleration spike of more than 1 g
    expect(minAx).toBeGreaterThan(-8.01) // the sensor saturates at 8 g
    expect(f.impacts.count).toBe(hits.length)
    expect(f.impacts.peak).toBeCloseTo(hits[0].type === 'robot-impact' ? hits[0].speed : 0, 6) // the first hit is the hardest
  })

  it('the wheels keep turning against the wall: the wheel odometry runs ahead of the real position', async () => {
    const { e } = await make({ walls: [WALL(2.0)] })
    drive(e, 12)
    e.run(1.5)
    const wheel0 = e.drivetrain!.states[0].wheelAngle * OFFSEASON_DRIVETRAIN.wheelRadius
    e.run(1.0)
    const wheel1 = e.drivetrain!.states[0].wheelAngle * OFFSEASON_DRIVETRAIN.wheelRadius
    expect(wheel1 - wheel0).toBeGreaterThan(1.5) // the robot code's odometry would integrate this as motion
    expect(e.getFrame().robotSpeed).toBeLessThan(0.1)
  })

  it('driving at a wall at an angle slides along it instead of snagging', async () => {
    const { e } = await make({ walls: [WALL(3.0)], start: { x: 0, y: 0, yaw: 0 } })
    // modules at 45 degrees: the robot goes forward and left while the wall stops the forward part
    OFFSEASON_DRIVETRAIN.modules.forEach((_, i) => e.drivetrain!.setAzimuth(i, Math.PI / 4))
    drive(e, 12)
    e.run(4)
    const f = e.getFrame()
    expect(f.robot[0]).toBeLessThan(3.0 - OFFSEASON_HALF[0] + 0.01)
    expect(f.robot[1]).toBeGreaterThan(3) // carried on along the wall
  })
})

describe('pushing', () => {
  it('a robot with more traction pushes another one; both move together', async () => {
    const { e, events } = await make({ others: [other(1.4, { mu: 0.5 })] })
    drive(e, 12)
    e.run(2)
    const f = e.getFrame()
    expect(f.others[0][0]).toBeGreaterThan(2.5) // pushed from 1.4
    const vOther = e.getFrame().others[0][0]
    expect(f.robot[0]).toBeGreaterThan(1.4 + 0.86 - 0.1) // still in contact (bumper to bumper is 0.86 m)
    expect(f.robot[0] + 0.86 - vOther).toBeLessThan(0.05)
    const hit = events.find((x) => x.type === 'robot-impact')
    expect(hit && hit.type === 'robot-impact' && hit.against).toBe('robot')
  })

  it('a robot with less traction cannot push a more grippy one', async () => {
    const { e } = await make({ others: [other(1.4, { mu: 1.6 })] })
    drive(e, 12)
    e.run(1.5) // the hit shoves it a little (the approach speed is 3.5 m/s), then 612 N of traction meets 860 N of resistance
    const settled = e.getFrame().others[0][0]
    e.run(1)
    const f = e.getFrame()
    expect(f.others[0][0] - settled).toBeLessThan(0.03) // it holds
    expect(f.others[0][0] - 1.4).toBeLessThan(0.9)
    expect(f.robotSpeed).toBeLessThan(0.1)
  })

  it('another robot follows its script, traction-limited', async () => {
    const { e } = await make({ others: [other(5, { start: { x: 5, y: 3, yaw: 0 }, script: [{ duration: 2, vx: 1.5, vy: 0, omega: 0 }] })] })
    e.run(2.2)
    const o = e.getFrame().others[0]
    expect(o[0]).toBeGreaterThan(5 + 2.4)
    expect(o[0]).toBeLessThan(5 + 3.1)
    expect(Math.abs(o[1] - 3)).toBeLessThan(0.02)
  })

  it('is deterministic and restores exactly, in the middle of a push', async () => {
    const run = async (): Promise<string> => {
      const { e } = await make({ others: [other(1.4, { mu: 0.5 })], walls: [WALL(6)] })
      drive(e, 12)
      e.run(3)
      return e.hash()
    }
    expect(await run()).toBe(await run())

    const { e } = await make({ others: [other(1.4, { mu: 0.5 })] })
    drive(e, 12)
    e.run(1.2)
    const snap = e.snapshot()
    e.run(1)
    const a = e.hash()
    e.restore(snap)
    e.run(1)
    expect(e.hash()).toBe(a)
  })
})

describe('terrain', () => {
  const RAMP = (x: number): number => 0.2 * Math.min(1, Math.max(0, x - 2)) // 11.3 degrees from x = 2 to 3, then a plateau at 20 cm

  it('the robot climbs a ramp: it rises, pitches nose up, and the Pigeon reports it', async () => {
    const { e } = await make({ terrain: (x) => RAMP(x) })
    drive(e, 12)
    let minPitch = 0
    let climbSpeed = 0
    for (let i = 0; i < 3500; i++) {
      e.step()
      const p = e.drivetrain!.pigeonState()
      minPitch = Math.min(minPitch, p.pitchDeg)
      if (i === 1000) climbSpeed = e.getFrame().robotSpeed
    }
    const f = e.getFrame()
    expect(f.robot[0]).toBeGreaterThan(3.5) // up and onto the plateau
    expect(f.robot[2] - OFFSEASON_HALF[2]).toBeCloseTo(0.2, 2) // standing on it
    expect(minPitch).toBeLessThan(-8) // nose up is negative pitch (right-hand rule about the left axis)
    expect(minPitch).toBeGreaterThan(-13)
    expect(Math.abs(e.drivetrain!.pigeonState().pitchDeg)).toBeLessThan(0.5) // level again on the plateau
    expect(climbSpeed).toBeGreaterThan(1)
  })

  it('a robot at rest on a slope feels gravity along its forward axis', async () => {
    const { e } = await make({ terrain: (x) => RAMP(x), start: { x: 2.5, y: 0, yaw: 0 } })
    e.run(0.05)
    const p = e.drivetrain!.pigeonState()
    expect(p.pitchDeg).toBeCloseTo(-11.3, 0)
    expect(p.accelXg).toBeCloseTo(0.196, 1) // sin(11.3 degrees), nose-up tilt puts gravity's reaction on +X
    expect(p.accelZg).toBeCloseTo(0.98, 1)
  })

  it('the slope slows the climb compared with flat ground', async () => {
    const flat = await make()
    const ramp = await make({ terrain: (x) => 0.25 * Math.min(1, Math.max(0, x - 0.2)) }) // 14 degrees from x = 0.2
    for (const { e } of [flat, ramp]) { drive(e, 12); e.run(0.8) } // still accelerating: at full speed the motors hold a gentle slope easily
    expect(ramp.e.getFrame().robot[0]).toBeLessThan(flat.e.getFrame().robot[0] - 0.05)
  })

  it('the REBUILT BUMP is a ridge beside each HUB and nothing elsewhere', () => {
    const cy = HUB_Y + 0.6 + BUMP.width / 2 // beside the HUB base, inside the bump's span in y
    expect(bumpHeight(HUB_X, cy)).toBeCloseTo(BUMP.height, 3)
    expect(bumpHeight(HUB_X + BUMP.depth / 4, cy)).toBeGreaterThan(0.01)
    expect(bumpHeight(HUB_X + BUMP.depth / 4, cy)).toBeLessThan(BUMP.height)
    expect(bumpHeight(HUB_X + BUMP.depth, cy)).toBe(0)
    expect(bumpHeight(8.27, cy)).toBe(0)
    expect(bumpHeight(HUB_X, HUB_Y)).toBe(0) // the HUB itself is not a bump
    expect(bumpHeight(16.54 - HUB_X, cy)).toBeCloseTo(BUMP.height, 3) // the other alliance's side
  })

  it('a robot drives over the REBUILT BUMP: up and back down, and it is not a collision', async () => {
    const cy = HUB_Y + 0.597 + BUMP.width / 2
    const robot: RobotSpec = { half: OFFSEASON_HALF, start: { x: 2.8, y: cy, yaw: 0 }, script: [], drivetrain: OFFSEASON_DRIVETRAIN, chassis: OFFSEASON.contact, alliance: 'blue' }
    const e = await Engine.create({ game: createRebuiltGame({ neutralFuel: 0, preload: 0 }), robot, seed: 3, solverIterations: 2 })
    drive(e, 8)
    let maxZ = 0
    let maxPitch = 0
    for (let i = 0; i < 2500; i++) {
      e.step()
      maxZ = Math.max(maxZ, e.getFrame().robot[2] - OFFSEASON_HALF[2])
      maxPitch = Math.max(maxPitch, Math.abs(e.drivetrain!.pigeonState().pitchDeg))
    }
    const f = e.getFrame()
    expect(f.robot[0]).toBeGreaterThan(6.2) // across and beyond (the BUMP spans x 4.06 to 5.19)
    expect(maxZ).toBeGreaterThan(BUMP.height * 0.4) // the ridge is narrower than the wheelbase: the plane through the four tires averages its peak
    expect(maxZ).toBeLessThan(BUMP.height + 0.01)
    expect(maxPitch).toBeGreaterThan(5)
    expect(maxPitch).toBeLessThan(20)
    expect(f.robot[2] - OFFSEASON_HALF[2]).toBeCloseTo(0, 2) // back on the floor
    expect(f.impacts.count).toBe(0) // the BUMP is climbed, not hit
  })
})
