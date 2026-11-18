// An example game for BALTA Crucible: a small walled floor, one goal and a short match.
// Copy this file into the games folder (Preferences > Open the game plugins folder), restart the app, and pick "game-plugin (plugin)" in the Game list.
// A game plugin is an ES module whose default export returns a game module (see src/engine/types.ts, GameModule). It runs inside the simulation, so only use files you trust.
const L = 6, W = 4, WALL = 0.5
const box = (label, center, half, friction = 0.6, restitution = 0.8) => ({ label, center, half, friction, restitution })

export default function createGame() {
  return {
    id: 'game-plugin-example',
    field: () => ({
      length: L,
      width: W,
      colliders: [
        box('floor', [L / 2, W / 2, -0.1], [L / 2, W / 2, 0.1], 0.8, 1),
        box('wall -y', [L / 2, -0.05, WALL / 2], [L / 2, 0.05, WALL / 2]), box('wall +y', [L / 2, W + 0.05, WALL / 2], [L / 2, 0.05, WALL / 2]),
        box('wall -x', [-0.05, W / 2, WALL / 2], [0.05, W / 2, WALL / 2]), box('wall +x', [L + 0.05, W / 2, WALL / 2], [0.05, W / 2, WALL / 2]),
      ],
      sensors: [{ id: 'goal', center: [5.4, 2, 0.2], half: [0.5, 0.7, 0.2], alliance: 'blue' }],
    }),
    pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.55, dragCoefficient: 0.47, rollingDamping: 2.0, color: 0xffb020 }],
    initialLayout: (rng) => Array.from({ length: 12 }, () => ({ spec: 'ball', position: [1.5 + rng() * 3, 0.5 + rng() * 3, 0.3] })),
    matchFlow: () => ({ phases: [{ name: 'auto', duration: 3 }, { name: 'teleop', duration: 7 }, { name: 'ended', duration: Infinity }] }),
    onEvent: (e, ctx) => {
      if (e.type !== 'piece-entered-sensor' || e.sensor.id !== 'goal' || ctx.phase === 'ended') return []
      ctx.removePiece(e.pieceId)
      return [{ alliance: 'blue', points: ctx.phase === 'auto' ? 3 : 2, reason: `ball in the goal (${ctx.phase})` }]
    },
    hud: () => ({ title: 'game-plugin-example' }),
  }
}
