// game-test: a tiny made-up game used to develop the engine before any real rules exist. Nothing here is FRC.
// 8 x 5 m walled floor, one raised block, a goal bin that eats balls (2 points in auto, 1 in teleop) and an elevated
// "hub" volume at (4.6, 4.0), where the OffSeason robot code aims its turret: 5 points in auto, 3 in teleop.
import type { BoxSpec, GameModule, RobotSpec, Score } from '../engine/types'

const L = 8
const W = 5
const WALL_H = 0.6
const GOAL = { center: [7.3, 2.5, 0.2] as [number, number, number], half: [0.6, 0.8, 0.2] as [number, number, number] }

export function createTestGame(): GameModule {
  const colliders: BoxSpec[] = [
    { label: 'floor', center: [L / 2, W / 2, -0.1], half: [L / 2, W / 2, 0.1], friction: 0.8, restitution: 1 },
    { label: 'wall -y', center: [L / 2, -0.05, WALL_H / 2], half: [L / 2, 0.05, WALL_H / 2], friction: 0.5, restitution: 0.9 },
    { label: 'wall +y', center: [L / 2, W + 0.05, WALL_H / 2], half: [L / 2, 0.05, WALL_H / 2], friction: 0.5, restitution: 0.9 },
    { label: 'wall -x', center: [-0.05, W / 2, WALL_H / 2], half: [0.05, W / 2, WALL_H / 2], friction: 0.5, restitution: 0.9 },
    { label: 'wall +x', center: [L + 0.05, W / 2, WALL_H / 2], half: [0.05, W / 2, WALL_H / 2], friction: 0.5, restitution: 0.9 },
    { label: 'block', center: [3.2, 3.9, 0.2], half: [0.3, 0.3, 0.2], friction: 0.6, restitution: 0.8 },
  ]
  return {
    id: 'game-test',
    field: () => ({
      length: L,
      width: W,
      colliders,
      sensors: [
        { id: 'goal', center: GOAL.center, half: GOAL.half, alliance: 'blue' },
        { id: 'hub', center: [4.6, 4.0, 1.75], half: [0.45, 0.45, 0.2], alliance: 'blue' },
      ],
    }),
    pieces: () => [{
      id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0.47, rollingDamping: 2.0, color: 0xffb020,
      magnus: { gain: 1.2, max: 0.4 },
      restitutionCurve: [[0, 1], [4, 0.9], [10, 0.7], [20, 0.5]],
    }],
    initialLayout: (rng) => {
      const out = []
      for (let i = 0; i < 30; i++) {
        out.push({ spec: 'ball', position: [2.2 + rng() * 3.6, 0.6 + rng() * 3.8, 0.3 + rng() * 1.0] as [number, number, number] })
      }
      return out
    },
    matchFlow: () => ({ phases: [{ name: 'auto', duration: 5 }, { name: 'teleop', duration: 25 }, { name: 'ended', duration: Infinity }] }),
    onEvent: (e, ctx) => {
      if (e.type !== 'piece-entered-sensor' || ctx.phase === 'ended') return []
      if (e.sensor.id !== 'goal' && e.sensor.id !== 'hub') return []
      ctx.removePiece(e.pieceId)
      const hub = e.sensor.id === 'hub'
      const auto = ctx.phase === 'auto'
      const s: Score = { alliance: 'blue', points: hub ? (auto ? 5 : 3) : (auto ? 2 : 1), reason: `ball in ${e.sensor.id} (${ctx.phase})` }
      return [s]
    },
    hud: () => ({ title: 'game-test' }),
  }
}

/** A scripted lap that plows through the pile and ends near the goal. Robot-relative commands. */
export const TEST_ROBOT: RobotSpec = {
  half: [0.43, 0.43, 0.12],
  start: { x: 1, y: 1, yaw: 0 },
  script: [
    { duration: 2.0, vx: 1.5, vy: 0, omega: 0 },
    { duration: 1.5, vx: 0, vy: 1.0, omega: 0 },
    { duration: 2.5, vx: 1.2, vy: 0, omega: 0.4 },
    { duration: 2.0, vx: 0, vy: 0, omega: -1.0 },
    { duration: 3.0, vx: -1.0, vy: -0.5, omega: 0 },
  ],
}
