// Game modules from outside: a team can drop a .js file into the games folder of the app's data directory and play it. The file is an ES module whose default
// export (or `createGame`) is a function returning a GameModule. This file only checks the shape of what came back, so a broken plugin is refused with a
// reason instead of crashing the simulation later. A plugin runs with the simulation's own permissions: load only files you trust.
import type { GameModule } from './types'

export function validateGameModule(g: unknown): string | null {
  if (!g || typeof g !== 'object') return 'the module did not return an object'
  const m = g as Record<string, unknown>
  if (typeof m.id !== 'string' || !m.id) return 'it has no id'
  for (const fn of ['field', 'pieces', 'initialLayout', 'matchFlow', 'onEvent', 'hud']) if (typeof m[fn] !== 'function') return `it has no ${fn}() function`
  const game = g as GameModule
  try {
    const f = game.field()
    if (!f || !(f.length > 0) || !(f.width > 0) || !Array.isArray(f.colliders) || !Array.isArray(f.sensors)) return 'field() must give length, width, colliders and sensors'
    for (const c of f.colliders) if (!Array.isArray(c.center) || c.center.length !== 3 || !Array.isArray(c.half) || c.half.length !== 3) return 'a collider needs center and half as [x, y, z]'
    const pieces = game.pieces()
    if (!Array.isArray(pieces)) return 'pieces() must give a list'
    for (const p of pieces) if (typeof p.id !== 'string' || !(p.radius > 0) || !(p.mass > 0)) return 'each piece needs an id, a radius and a mass'
    const flow = game.matchFlow()
    if (!flow || !Array.isArray(flow.phases) || flow.phases.length === 0 || flow.phases.some((p) => typeof p.name !== 'string' || !(p.duration > 0))) return 'matchFlow() must give phases with a name and a duration'
    const layout = game.initialLayout(() => 0.5)
    if (!Array.isArray(layout)) return 'initialLayout() must give a list'
    const known = new Set(pieces.map((p) => p.id))
    for (const s of layout) if (!known.has(s.spec)) return `the layout uses an unknown piece "${s.spec}"`
    if (!game.hud() || typeof game.hud().title !== 'string') return 'hud() must give a title'
  } catch (e) { return `calling it failed: ${(e as Error).message}` }
  return null
}

/** The names the app accepts for a plugin file: plain .js names, no folders. */
export const PLUGIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.js$/

/** Takes a loaded ES module and returns the game it makes, or a reason. */
export function gameFromModule(mod: unknown): { game: GameModule } | { error: string } {
  const m = mod as { default?: unknown; createGame?: unknown } | null
  const make = typeof m?.default === 'function' ? m.default : typeof m?.createGame === 'function' ? m.createGame : null
  if (!make) return { error: 'the file must export a function (default or createGame) that returns a game module' }
  let game: unknown
  try { game = (make as () => unknown)() } catch (e) { return { error: `the function threw: ${(e as Error).message}` } }
  const why = validateGameModule(game)
  return why ? { error: why } : { game: game as GameModule }
}
