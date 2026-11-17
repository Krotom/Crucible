import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import type { BoxSpec, GameModule, PieceSpec, RobotSpec } from '../src/engine/types'
import { createTestGame, TEST_ROBOT } from '../src/games/test'

const FAR_ROBOT: RobotSpec = { half: [0.4, 0.4, 0.1], start: { x: -50, y: -50, yaw: 0 }, script: [] }

function ball(over: Partial<PieceSpec> = {}): PieceSpec {
  return { id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0, rollingDamping: 0, color: 0xffffff, ...over }
}

/** A bare game: optional floor, no sensors, no pieces of its own. */
function bare(opts: { floor?: boolean; piece?: Partial<PieceSpec> } = {}): GameModule {
  const colliders: BoxSpec[] = opts.floor
    ? [{ center: [0, 0, -0.1], half: [50, 50, 0.1], friction: 0.8, restitution: 1 }]
    : []
  return {
    id: 'bare',
    field: () => ({ length: 100, width: 100, colliders, sensors: [] }),
    pieces: () => [ball(opts.piece)],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: () => [],
    hud: () => ({ title: 'bare' }),
  }
}

describe('ballistics', () => {
  it('follows the analytic parabola without drag', async () => {
    const e = await Engine.create({ game: bare(), robot: FAR_ROBOT, seed: 1 })
    const id = e.spawn({ spec: 'ball', position: [0, 0, 10], velocity: [3, 1, 5] })
    e.run(0.5)
    const p = e.pieceState(id)!.position
    const t = 0.5
    expect(p[0]).toBeCloseTo(3 * t, 2)
    expect(p[1]).toBeCloseTo(1 * t, 2)
    expect(Math.abs(p[2] - (10 + 5 * t - 0.5 * 9.81 * t * t))).toBeLessThan(0.01)
  })

  it('approaches the analytic quadratic-drag velocity', async () => {
    const e = await Engine.create({ game: bare({ piece: { dragCoefficient: 0.47 } }), robot: FAR_ROBOT, seed: 1 })
    const id = e.spawn({ spec: 'ball', position: [0, 0, 1000] })
    e.run(3)
    const m = 0.2
    const g = 9.81
    const k = 0.5 * 1.225 * 0.47 * Math.PI * 0.075 ** 2 // F = k v^2
    const vt = Math.sqrt((m * g) / k)
    const expected = vt * Math.tanh((g * 3) / vt)
    const v = -e.pieceState(id)!.velocity[2]
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.02)
    expect(v).toBeLessThan(g * 3) // slower than free fall
  })
})

describe('bounce', () => {
  it('rebounds to about e^2 of the drop height', async () => {
    const e = await Engine.create({ game: bare({ floor: true }), robot: FAR_ROBOT, seed: 1 })
    const r = 0.075
    const id = e.spawn({ spec: 'ball', position: [0, 0, 1 + r] })
    // fall (~0.45 s), then record the apex after the first impact
    let apex = 0
    let bounced = false
    for (let i = 0; i < 1500; i++) {
      e.step()
      const s = e.pieceState(id)!
      if (!bounced && s.velocity[2] > 0.5) bounced = true
      if (bounced) apex = Math.max(apex, s.position[2] - r)
      if (bounced && s.velocity[2] < 0) break
    }
    expect(bounced).toBe(true)
    const ratio = apex / 1.0
    expect(ratio).toBeGreaterThan(0.55 ** 2 * 0.9)
    expect(ratio).toBeLessThan(0.55 ** 2 * 1.1)
  })
})

describe('determinism and snapshots', () => {
  const cfg = (seed: number) => ({ game: createTestGame(), robot: TEST_ROBOT, seed })

  it('two runs with the same seed give the same state hash; another seed differs', async () => {
    const a = await Engine.create(cfg(42))
    const b = await Engine.create(cfg(42))
    const c = await Engine.create(cfg(43))
    a.run(8); b.run(8); c.run(8)
    expect(a.hash()).toBe(b.hash())
    expect(a.hash()).not.toBe(c.hash())
    expect(a.steps).toBe(8000)
  })

  it('restoring a snapshot replays the same future, also in a new engine', async () => {
    const a = await Engine.create(cfg(7))
    a.run(3)
    const snap = a.snapshot()
    const hashAtSnap = a.hash()
    a.run(3)
    const future = a.hash()

    a.restore(snap)
    expect(a.hash()).toBe(hashAtSnap)
    a.run(3)
    expect(a.hash()).toBe(future)

    const fresh = await Engine.create(cfg(999)) // different seed and state, then overwritten by the snapshot
    fresh.restore(snap)
    expect(fresh.hash()).toBe(hashAtSnap)
    fresh.run(3)
    expect(fresh.hash()).toBe(future)
  })

  it('reset returns to the initial state', async () => {
    const a = await Engine.create(cfg(5))
    const h0 = a.hash()
    a.run(2)
    expect(a.hash()).not.toBe(h0)
    a.reset()
    expect(a.hash()).toBe(h0)
    a.reset(6)
    expect(a.hash()).not.toBe(h0)
  })
})

describe('game plug-in host', () => {
  it('scores by phase, consumes pieces and survives snapshots', async () => {
    const e = await Engine.create({ game: createTestGame(), robot: { ...TEST_ROBOT, script: [] }, seed: 1 })
    for (const id of e.pieceIds) e.removePiece(id) // clear the random pile
    expect(e.phase).toBe('auto')
    e.spawn({ spec: 'ball', position: [6.4, 2.5, 0.3], velocity: [3, 0, 0] })
    e.run(0.6)
    expect(e.scoreTotals.blue).toBe(2) // auto: 2 points
    expect(e.pieceCount).toBe(0) // consumed by the goal

    e.run(4.6) // t = 5.2 s: teleop
    expect(e.phase).toBe('teleop')
    const snap = e.snapshot()
    e.spawn({ spec: 'ball', position: [6.4, 2.5, 0.3], velocity: [3, 0, 0] })
    e.run(0.6)
    expect(e.scoreTotals.blue).toBe(3) // teleop: 1 point
    expect(e.log.map((s) => s.points)).toEqual([2, 1])

    e.restore(snap)
    expect(e.scoreTotals.blue).toBe(2)
    expect(e.phase).toBe('teleop')
  })

  it('stops scoring after the match ends', async () => {
    const e = await Engine.create({ game: createTestGame(), robot: { ...TEST_ROBOT, script: [] }, seed: 1 })
    for (const id of e.pieceIds) e.removePiece(id)
    e.run(30.1)
    expect(e.phase).toBe('ended')
    e.spawn({ spec: 'ball', position: [6.4, 2.5, 0.3], velocity: [3, 0, 0] })
    e.run(0.6)
    expect(e.scoreTotals.blue).toBe(0)
  })
})

describe('scripted robot', () => {
  it('follows its script and pushes balls', async () => {
    const e = await Engine.create({ game: createTestGame(), robot: TEST_ROBOT, seed: 1 })
    for (const id of e.pieceIds) e.removePiece(id)
    const id = e.spawn({ spec: 'ball', position: [1.8, 1, 0.075] })
    e.run(2)
    const f = e.getFrame()
    expect(f.robot[0]).toBeCloseTo(4.0, 1) // 1 m + 1.5 m/s * 2 s
    expect(f.robot[1]).toBeCloseTo(1.0, 1)
    expect(e.pieceState(id)!.position[0]).toBeGreaterThan(3.5) // shoved ahead of the bumper
  })
})

describe('golden run', () => {
  // The state hash of game-test, seed 42, after 8 s. The same value comes out of the app's worker in Electron/Chromium
  // and out of Node, so a change here means the physics or the game changed (update it on purpose, never to silence a failure).
  it('matches the recorded hash', async () => {
    const e = await Engine.create({ game: createTestGame(), robot: TEST_ROBOT, seed: 42 })
    e.run(8)
    expect(e.hash()).toBe('d621ab8a911ca618')
  })
})
