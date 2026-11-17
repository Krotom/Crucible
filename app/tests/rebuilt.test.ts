import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { GameContext, RobotSpec, ScriptSegment } from '../src/engine/types'
import {
  ALLIANCE_ZONE_DEPTH, CENTER_LINE, createRebuiltGame, counts, FIELD_LENGTH, FIELD_WIDTH, gameDataChar, HUB_RIM, HUB_X, HUB_Y, hubActive, phaseAt,
} from '../src/games/rebuilt'

const robot = (start: { x: number; y: number; yaw: number }, script: ScriptSegment[] = []): RobotSpec => ({ half: [0.43, 0.43, 0.12], start, script, alliance: 'blue' })

async function make(r: RobotSpec = robot({ x: 1, y: 7, yaw: 0 })): Promise<Engine> {
  return Engine.create({ game: createRebuiltGame(), robot: r, seed: 5 })
}

/** Drops a ball into the blue HUB opening from just above the sensor. */
function dropIntoBlueHub(e: Engine): void {
  e.spawn({ spec: 'ball', position: [HUB_X, HUB_Y, HUB_RIM + 0.2], velocity: [0, 0, -2] })
}

describe('match flow and HUB activation (rules extract sections 4)', () => {
  it('has the manual periods', () => {
    expect(phaseAt(0)).toBe('auto')
    expect(phaseAt(19.9)).toBe('auto')
    expect(phaseAt(20.1)).toBe('delay')
    expect(phaseAt(23.1)).toBe('transition')
    expect(phaseAt(33.1)).toBe('shift1')
    expect(phaseAt(58.1)).toBe('shift2')
    expect(phaseAt(83.1)).toBe('shift3')
    expect(phaseAt(108.1)).toBe('shift4')
    expect(phaseAt(133.1)).toBe('endgame')
    expect(phaseAt(163.1)).toBe('ended')
  })

  it('alternates the HUBs by the AUTO winner (Table 6-3)', () => {
    // red won AUTO: red HUB inactive in shifts 1 and 3, blue inactive in 2 and 4
    const rows: [string, boolean, boolean][] = [
      ['auto', true, true], ['transition', true, true], ['shift1', true, false], ['shift2', false, true],
      ['shift3', true, false], ['shift4', false, true], ['endgame', true, true], ['ended', false, false],
    ]
    for (const [phase, blue, red] of rows) {
      expect(hubActive('blue', phase, 'red'), `blue ${phase}`).toBe(blue)
      expect(hubActive('red', phase, 'red'), `red ${phase}`).toBe(red)
    }
    // blue won: the mirror image
    expect(hubActive('blue', 'shift1', 'blue')).toBe(false)
    expect(hubActive('red', 'shift1', 'blue')).toBe(true)
  })

  it('counts FUEL for 3 s after a HUB deactivates, but not after that', () => {
    expect(counts('blue', 34, 'blue')).toBe(true) // 1 s into the shift that deactivated it
    expect(counts('blue', 35.9, 'blue')).toBe(true)
    expect(counts('blue', 36.5, 'blue')).toBe(false)
    expect(counts('blue', 60, 'blue')).toBe(true) // active again in shift 2
    expect(counts('blue', 164, 'blue')).toBe(true) // within 3 s of the end of the match
    expect(counts('blue', 167, 'blue')).toBe(false)
  })
})

describe('layout (6.3.4)', () => {
  it('stages 408 minus the preload in the neutral zone and 24 per DEPOT, without overlaps', async () => {
    const e = await Engine.create({ game: createRebuiltGame({ preload: 3 }), robot: robot({ x: 1, y: 7, yaw: 0 }), seed: 1 })
    expect(e.pieceCount).toBe(408 - 3 + 48)
    const ids = e.pieceIds
    const pos = ids.map((id) => e.pieceState(id)!.position)
    let minD = Infinity
    for (let i = 0; i < pos.length; i += 7) for (let j = i + 1; j < pos.length; j++) minD = Math.min(minD, Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]))
    expect(minD).toBeGreaterThan(0.149)
    const inPile = pos.filter((p) => Math.abs(p[0] - CENTER_LINE) < 1)
    expect(inPile.length).toBeGreaterThanOrEqual(404)
    expect(ids.every((id) => e.pieceState(id)!.sleeping)).toBe(true) // at rest, costing nothing
  })
})

describe('scoring', () => {
  it('scores 1 per FUEL through an active HUB, removes it, and gives it back through an exit', async () => {
    const e = await make()
    for (const id of e.pieceIds) e.removePiece(id)
    dropIntoBlueHub(e)
    e.run(0.6)
    expect(e.scoreTotals.blue).toBe(1)
    expect(e.pieceCount).toBe(0) // processed
    e.run(2)
    expect(e.pieceCount).toBe(1) // out of an exit on the neutral zone side
    const s = e.pieceState(e.pieceIds[0])!
    expect(s.position[0]).toBeGreaterThan(HUB_X + 0.597)
  })

  it('decides the first inactive HUB from AUTO FUEL and scores nothing in an inactive HUB (but still processes it)', async () => {
    const e = await make()
    for (const id of e.pieceIds) e.removePiece(id)
    dropIntoBlueHub(e)
    e.run(0.6) // blue scores 1 in AUTO, red 0
    e.run(40) // t = 40.6 s: shift 1
    expect(e.phase).toBe('shift1')
    expect(gameDataChar(e.snapshot().gameState, 40.6)).toBe('B') // blue won AUTO, so blue's HUB is inactive first
    dropIntoBlueHub(e)
    e.run(0.6) // outside the 3 s grace, inactive: no points
    expect(e.scoreTotals.blue).toBe(1)
    expect(e.pieceCount).toBeLessThanOrEqual(1) // it was processed anyway (and may already be coming back out)
  })

  it('counts a ball that arrives within 3 s after the HUB deactivates', async () => {
    const e = await make()
    for (const id of e.pieceIds) e.removePiece(id)
    dropIntoBlueHub(e)
    e.run(0.6)
    e.run(32.5 - 0.6) // 32.5 s: still the TRANSITION SHIFT
    e.run(1.5) // 34 s: 1 s into shift 1, blue inactive
    dropIntoBlueHub(e)
    e.run(0.5)
    expect(e.scoreTotals.blue).toBe(2)
  })

  it('breaks an AUTO tie with the engine random generator', () => {
    const game = createRebuiltGame()
    const pick = (r: number): string => {
      const state: Record<string, unknown> = {}
      const ctx = { time: 23, phase: 'transition', rng: () => r, state, removePiece: () => {}, spawn: () => 0, robot: { x: 0, y: 0, yaw: 0, half: [0.43, 0.43] as [number, number], alliance: 'blue' as const } }
      game.onEvent({ type: 'phase-changed', from: 'delay', to: 'transition' }, ctx)
      return gameDataChar(state, 24)
    }
    expect(pick(0.2)).toBe('B')
    expect(pick(0.8)).toBe('R')
    // and a full engine run with the same seed gives the same answer twice (the choice comes from the seeded generator)
  })

  it('puts FUEL back on the field after it leaves over a guardrail', async () => {
    const e = await make()
    for (const id of e.pieceIds) e.removePiece(id)
    e.spawn({ spec: 'ball', position: [8, -0.5, 0.3] }) // outside the guardrail
    e.run(0.05)
    expect(e.pieceCount).toBe(0)
    e.run(2)
    expect(e.pieceCount).toBe(1)
    const p = e.pieceState(e.pieceIds[0])!.position
    expect(p[1]).toBeGreaterThan(0)
    expect(p[1]).toBeLessThan(FIELD_WIDTH)
  })
})

describe('G403: do not completely cross the CENTER LINE in AUTO', () => {
  it('fines once per crossing in AUTO, credits the opponent 15, and not in TELEOP', async () => {
    // from x = 7.2 at 2 m/s the bumpers are completely across (minX > 8.27) at about x = 8.7, 0.75 s later
    const e = await make(robot({ x: 7.2, y: 2, yaw: 0 }, [
      { duration: 1.5, vx: 2, vy: 0, omega: 0 }, // across
      { duration: 1.5, vx: -2, vy: 0, omega: 0 }, // back
      { duration: 1.5, vx: 2, vy: 0, omega: 0 }, // across again
    ]))
    for (const id of e.pieceIds) e.removePiece(id)
    e.run(1.4)
    expect(e.scoreTotals.red).toBe(15)
    e.run(2.6) // back, and over again at about 3.75 s
    expect(e.scoreTotals.red).toBe(30)
    expect(e.log.every((s) => s.reason.startsWith('G403'))).toBe(true)

    const t = await make(robot({ x: 7.2, y: 2, yaw: 0 }, [{ duration: 25, vx: 0, vy: 0, omega: 0 }, { duration: 1.5, vx: 2, vy: 0, omega: 0 }]))
    for (const id of t.pieceIds) t.removePiece(id)
    t.run(27) // the crossing happens in TELEOP: allowed
    expect(t.scoreTotals.red).toBe(0)
  })

  it('does not fine a robot that is only partly across', async () => {
    const e = await make(robot({ x: 8.3, y: 2, yaw: 0 }))
    for (const id of e.pieceIds) e.removePiece(id)
    e.run(1) // bumpers reach back over the line
    expect(e.scoreTotals.red).toBe(0)
  })
})

describe('G407: launch into your HUB only with your bumpers partly in your ALLIANCE ZONE', () => {
  function ctx(x: number, time: number, state: Record<string, unknown> = {}): GameContext {
    return { time, phase: 'shift2', rng: () => 0.5, state, removePiece: () => {}, spawn: () => 0, robot: { x, y: HUB_Y, yaw: 0, half: [0.43, 0.43], alliance: 'blue' } }
  }
  const game = createRebuiltGame()
  /** A vacuum shot from (x, y) at the given speed and elevation toward the blue HUB. */
  function shot(x: number, elevDeg: number, speed: number): { position: [number, number, number]; velocity: [number, number, number] } {
    const e = (elevDeg * Math.PI) / 180
    return { position: [x, HUB_Y, 0.62], velocity: [-speed * Math.cos(e), 0, speed * Math.sin(e)] }
  }
  const launched = (s: ReturnType<typeof shot>) => ({ type: 'piece-launched' as const, spec: 'ball', speed: 7, position: s.position, velocity: s.velocity, pieceId: 0 })

  it('fines a robot outside its zone shooting down into its own HUB', () => {
    // from x = 7.5, aim back at the HUB (center x = 4.625): range 2.9 m; solve the speed for a 55 degree arc
    const range = 7.5 - HUB_X
    const elev = (55 * Math.PI) / 180
    const v = Math.sqrt((9.81 * range * range) / (2 * Math.cos(elev) ** 2 * (range * Math.tan(elev) - (HUB_RIM - 0.62))))
    const s = shot(7.5, 55, v)
    const out = game.onEvent(launched(s), ctx(7.5, 60))
    expect(out).toHaveLength(1)
    expect(out[0].alliance).toBe('red')
    expect(out[0].points).toBe(15)
  })

  it('does not fine a robot whose bumpers are partly inside its zone, or a shot that is not into the HUB', () => {
    const range = 4.3 - HUB_X
    const elev = (60 * Math.PI) / 180
    const v = Math.sqrt((9.81 * range * range) / (2 * Math.cos(elev) ** 2 * (range * Math.tan(elev) - (HUB_RIM - 0.62))))
    expect(game.onEvent(launched(shot(4.3, 60, v)), ctx(4.3, 60))).toHaveLength(0) // bumper reaches x = 3.87 < 4.028
    // outside the zone but throwing the ball across the field (a pass), not at the HUB
    expect(game.onEvent(launched({ position: [7.5, HUB_Y, 0.62], velocity: [6, 2, 4] }), ctx(7.5, 60))).toHaveLength(0)
  })

  it('counts a burst of launches as one instance (3 s)', () => {
    const range = 7.5 - HUB_X
    const elev = (55 * Math.PI) / 180
    const v = Math.sqrt((9.81 * range * range) / (2 * Math.cos(elev) ** 2 * (range * Math.tan(elev) - (HUB_RIM - 0.62))))
    const s = shot(7.5, 55, v)
    const state: Record<string, unknown> = {}
    expect(game.onEvent(launched(s), ctx(7.5, 60, state))).toHaveLength(1)
    expect(game.onEvent(launched(s), ctx(7.5, 61, state))).toHaveLength(0)
    expect(game.onEvent(launched(s), ctx(7.5, 64, state))).toHaveLength(1)
    expect(ALLIANCE_ZONE_DEPTH).toBeCloseTo(4.028, 3)
    expect(FIELD_LENGTH).toBeCloseTo(16.54, 2)
  })
})
