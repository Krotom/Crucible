import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { BoxSpec, GameEvent, GameModule, PieceSpec, RobotSpec } from '../src/engine/types'
import { createTestGame } from '../src/games/test'
import { OFFSEASON } from '../src/robots/offseason'

const FLOOR: BoxSpec = { center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 1 }

const BALL: PieceSpec = {
  id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0.47, rollingDamping: 2,
  magnus: { gain: 1.2, max: 0.4 }, restitutionCurve: [[0, 1], [4, 0.9], [10, 0.7], [20, 0.5]], color: 0,
}

function game(events: GameEvent[] = [], piece: PieceSpec = BALL): GameModule {
  return {
    id: 'bare',
    field: () => ({ length: 200, width: 200, colliders: [FLOOR], sensors: [] }),
    pieces: () => [piece],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: (e) => { events.push(e); return [] },
    hud: () => ({ title: 'bare' }),
  }
}

const ROBOT: RobotSpec = {
  half: OFFSEASON.bumper, start: { x: -50, y: -50, yaw: 0 }, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls,
}
const ID = Object.fromEntries(OFFSEASON.mechanisms.map((m) => [m.name, m.id]))

async function make(events: GameEvent[] = [], piece: PieceSpec = BALL): Promise<Engine> {
  return Engine.create({ game: game(events, piece), robot: ROBOT, seed: 1 })
}

/** Opens the intake fully and spins the roller (what the robot code does in the intaking state: the roller runs near 17 rps, 3 V here). */
function intakeOn(e: Engine): void {
  e.setMotorVolts(ID.intakeDriver, 12)
  e.setMotorVolts(ID.intakeRoller, 3)
  e.run(1.2)
  e.setMotorVolts(ID.intakeDriver, 0.0) // coasts; hold the extension by pinning the mechanism
  e.mechanisms.get(ID.intakeDriver)!.angle = OFFSEASON.balls!.intake.travel / OFFSEASON.balls!.intake.metersPerRotation * 2 * Math.PI
  e.mechanisms.get(ID.intakeDriver)!.speed = 0
}

function boxCenter(e: Engine): [number, number, number] { return e.getFrame().capture!.center }

describe('ball material: Magnus and foam', () => {
  it('backspin lifts a shot: it flies higher and farther than the same shot without spin', async () => {
    const run = async (spin: number): Promise<{ apex: number; range: number }> => {
      const e = await make()
      const id = e.spawn({ spec: 'ball', position: [0, 0, 1], velocity: [10, 0, 6], angularVelocity: [0, -spin, 0] })
      let apex = 0
      for (let i = 0; i < 3000; i++) {
        e.step()
        const s = e.pieceState(id)!
        apex = Math.max(apex, s.position[2])
        if (s.position[2] < 0.1 && i > 100) return { apex, range: s.position[0] }
      }
      return { apex, range: e.pieceState(id)!.position[0] }
    }
    const none = await run(0)
    const back = await run(100) // rad/s, spin parameter about 0.75 at launch: lift capped at C_L 0.4
    expect(back.apex).toBeGreaterThan(none.apex + 0.1)
    expect(back.range).toBeGreaterThan(none.range + 0.3)
  })

  it('a ball with spin about the vertical axis does not lift (the force is perpendicular to the spin)', async () => {
    const e = await make()
    const flat = e.spawn({ spec: 'ball', position: [0, 0, 5], velocity: [10, 0, 0], angularVelocity: [0, 0, 100] })
    const none = await make()
    const ref = none.spawn({ spec: 'ball', position: [0, 0, 5], velocity: [10, 0, 0] })
    e.run(0.3); none.run(0.3)
    // z-spin curves the ball sideways but does not change its height
    expect(e.pieceState(flat)!.position[2]).toBeCloseTo(none.pieceState(ref)!.position[2], 2)
    expect(Math.abs(e.pieceState(flat)!.position[1])).toBeGreaterThan(0.05)
  })

  it('harder hits bounce less (foam restitution depends on speed)', async () => {
    const bounceRatio = async (drop: number): Promise<number> => {
      const e = await make(undefined, { ...BALL, dragCoefficient: 0, magnus: undefined })
      const id = e.spawn({ spec: 'ball', position: [0, 0, drop + 0.075] })
      let apex = 0
      let bounced = false
      for (let i = 0; i < 6000; i++) {
        e.step()
        const s = e.pieceState(id)!
        if (!bounced && s.velocity[2] > 0.3) bounced = true
        if (bounced) apex = Math.max(apex, s.position[2] - 0.075)
        if (bounced && s.velocity[2] < 0) break
      }
      return apex / drop
    }
    const soft = await bounceRatio(0.3) // about 2.4 m/s on impact
    const hard = await bounceRatio(8) // about 12.5 m/s
    expect(soft).toBeGreaterThan(hard + 0.05)
    expect(hard).toBeGreaterThan(0.05)
  })
})

describe('intake capture', () => {
  it('captures a ball in the open capture box while the roller pulls in, and reports it', async () => {
    const events: GameEvent[] = []
    const e = await make(events)
    intakeOn(e)
    const [cx, cy] = boxCenter(e)
    e.spawn({ spec: 'ball', position: [cx, cy, 0.1] })
    expect(e.pieceCount).toBe(1)
    e.run(0.05)
    expect(e.pieceCount).toBe(0)
    expect(e.ballSystem!.held.length).toBe(1)
    expect(e.ballSystem!.captured).toBe(1)
    expect(events.some((x) => x.type === 'piece-captured')).toBe(true)
  })

  it('does not capture with the roller off, with the intake retracted, or a fast ball', async () => {
    // roller off
    let e = await make()
    e.setMotorVolts(ID.intakeDriver, 12)
    e.run(1.2)
    e.mechanisms.get(ID.intakeDriver)!.angle = 4 * 2 * Math.PI
    let [cx, cy] = boxCenter(e)
    e.spawn({ spec: 'ball', position: [cx, cy, 0.1] })
    e.run(0.2)
    expect(e.ballSystem!.held.length).toBe(0)

    // retracted
    e = await make()
    e.setMotorVolts(ID.intakeRoller, 3)
    e.run(1)
    ;[cx, cy] = boxCenter(e)
    e.spawn({ spec: 'ball', position: [cx, cy, 0.1] })
    e.run(0.1)
    expect(e.ballSystem!.held.length).toBe(0)

    // a ball flying through faster than the limit
    e = await make()
    intakeOn(e)
    ;[cx, cy] = boxCenter(e)
    e.spawn({ spec: 'ball', position: [cx, cy, 0.1], velocity: [0, 12, 0] })
    e.step()
    expect(e.ballSystem!.held.length).toBe(0)
  })

  it('takes balls one at a time and stops when the mouth is full', async () => {
    const e = await make()
    intakeOn(e)
    const [cx, cy] = boxCenter(e)
    for (let i = 0; i < 4; i++) e.spawn({ spec: 'ball', position: [cx, cy + (i - 1.5) * 0.16, 0.1] })
    e.run(0.02)
    expect(e.ballSystem!.held.length).toBe(1) // the others wait until the first has moved on
    e.run(1.5)
    expect(e.ballSystem!.held.length).toBeGreaterThanOrEqual(2)
  })
})

describe('stages and beam breaks', () => {
  async function withHeldBall(): Promise<Engine> {
    const e = await make()
    intakeOn(e)
    const [cx, cy] = boxCenter(e)
    e.spawn({ spec: 'ball', position: [cx, cy, 0.1] })
    e.run(0.05)
    expect(e.ballSystem!.held.length).toBe(1)
    return e
  }

  it('rides the intake roller to the indexer entrance and waits there', async () => {
    const e = await withHeldBall()
    e.run(1)
    const s = e.ballSystem!.held[0]
    expect(s).toBeGreaterThan(0.29)
    expect(s).toBeLessThan(0.45)
    expect(e.ballSystem!.beams[0]).toBe(true) // the beam at the indexer entrance sees it
    expect(e.ballSystem!.beams[1]).toBe(false)
  })

  it('the indexer carries it to the feeder, the feeder to the exit; beams follow it', async () => {
    const e = await withHeldBall()
    e.setMotorVolts(ID.intakeRoller, 0)
    e.setMotorVolts(ID.indexer, -9) // the robot code feeds with the indexer running negative
    e.run(2)
    expect(e.ballSystem!.beams).toEqual([false, true, false]) // waiting at the feeder entrance
    e.setMotorVolts(ID.indexer, 0)
    e.setMotorVolts(ID.feeder, 7)
    e.run(0.3)
    // no flywheel: the ball goes to the end of the path and waits, nothing is launched
    expect(e.ballSystem!.shots).toBe(0)
    expect(e.ballSystem!.held.length).toBe(1)
    expect(e.ballSystem!.beams[2]).toBe(true)
  })

  it('launches from the exit only with the feeder pushing and the flywheel at speed, along the turret and hood state', async () => {
    const events: GameEvent[] = []
    const e = await make(events)
    const sh = OFFSEASON.balls!.shooter
    e.ballSystem!.held = [0.95] // a piece waiting at the exit
    // turret 30 degrees left, hood at 2.0 rotations (20 degrees), flywheel 40 rps
    e.mechanisms.get(ID.turret)!.angle = (30 * Math.PI) / 180
    e.mechanisms.get(ID.hood)!.angle = 2.0 * 2 * Math.PI
    const fly = e.mechanisms.get(ID.shooter)!
    const wheelVolts = 10
    e.setMotorVolts(ID.shooter, wheelVolts)
    e.run(0.6)
    expect(fly.rps).toBeGreaterThan(30)
    expect(e.ballSystem!.shots).toBe(0) // the feeder is not pushing yet
    e.setMotorVolts(ID.feeder, 7)
    for (let i = 0; i < 300 && e.ballSystem!.shots === 0; i++) e.step()
    expect(e.ballSystem!.shots).toBe(1)
    const id = e.pieceIds[0]
    const s = e.pieceState(id)! // read on the step of the launch, before gravity has changed it
    const speed = Math.hypot(...s.velocity)
    const expected = sh.efficiency * 2 * Math.PI * sh.wheelRadius * fly.rps
    expect(speed).toBeGreaterThan(expected * 0.9)
    expect(speed).toBeLessThan(expected * 1.05)
    // heading 30 degrees left of the robot's +X, elevation 80 - 20 = 60 degrees
    const horizontal = Math.hypot(s.velocity[0], s.velocity[1])
    expect((Math.atan2(s.velocity[1], s.velocity[0]) * 180) / Math.PI).toBeCloseTo(30, 0)
    expect((Math.atan2(s.velocity[2], horizontal) * 180) / Math.PI).toBeGreaterThan(55)
    // backspin: the Magnus force on this spin points up (w x v has a positive z component)
    const w = s.angularVelocity
    expect(w[0] * s.velocity[1] - w[1] * s.velocity[0]).toBeGreaterThan(0)
    expect(events.find((x) => x.type === 'piece-launched')).toBeDefined()
  })

  it('a ball launched from the robot reaches the hub volume and scores', async () => {
    const g = createTestGame()
    const e = await Engine.create({ game: g, robot: { ...ROBOT, start: { x: 2.4, y: 4.0, yaw: 0 } }, seed: 3 })
    for (const id of e.pieceIds) e.removePiece(id)
    e.run(5.5) // into teleop
    // aim a vacuum-ballistic shot from the shooter exit at the middle of the hub volume: 60 degrees up, speed solved
    const sh = OFFSEASON.balls!.shooter
    const ox = 2.4 + sh.axis[0] + sh.exitForward
    const oy = 4.0 + sh.axis[1]
    const dx = 4.6 - ox
    const dy = 4.0 - oy
    const range = Math.hypot(dx, dy)
    const elev = (60 * Math.PI) / 180
    const dz = 1.75 - sh.exitHeight
    const v = Math.sqrt((9.81 * range * range) / (2 * Math.cos(elev) ** 2 * (range * Math.tan(elev) - dz)))
    const h = Math.atan2(dy, dx)
    e.spawn({ spec: 'ball', position: [ox, oy, sh.exitHeight], velocity: [v * Math.cos(elev) * Math.cos(h), v * Math.cos(elev) * Math.sin(h), v * Math.sin(elev)] })
    e.run(2.5)
    expect(e.scoreTotals.blue).toBe(3) // hub in teleop (drag and no spin cost a little; the box is generous)
  })

  it('snapshots keep held pieces, shots and the beam state; the future replays identically', async () => {
    const e = await withHeldBall()
    e.run(0.5)
    const snap = e.snapshot()
    e.setMotorVolts(ID.indexer, -9)
    e.run(1)
    const h = e.hash()
    e.restore(snap)
    expect(e.ballSystem!.held.length).toBe(1)
    e.setMotorVolts(ID.indexer, -9)
    e.run(1)
    expect(e.hash()).toBe(h)
  })
})
