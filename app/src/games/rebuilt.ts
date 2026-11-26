// REBUILT (2026): the field, FUEL, match flow, HUB activation, scoring and the two fouls the user asked for (G403 and G407).
// The rules are taken from rules/REBUILT_RULES_EXTRACT.md, which lists the section of the game manual for each fact and marks what is inferred.
// The geometry (HUB funnel, BUMP, TRENCH, DEPOT, TOWER, walls, where every FUEL starts) is measured from the official field CAD: see
// rebuilt-cad.ts and tools/build-field.mjs. What the CAD does not say is marked ASSUMED. Coordinates: origin at the blue wall corner, +X toward the red wall.
import type {
  Alliance, BoxSpec, GameContext, GameEvent, GameModule, PieceSpawn, PieceSpec, Score, SensorSpec, Vec3,
} from '../engine/types'
import { CAD_BUMP_RIDGE, CAD_DEPOT_BLUE, CAD_DEPOT_RED, CAD_FUNNEL, CAD_NEUTRAL } from './rebuilt-cad'

const IN = 0.0254
export const FIELD_LENGTH = 651.2 * IN // 16.54 m (manual 5.2)
export const FIELD_WIDTH = 317.7 * IN // 8.07 m
const CENTER_LINE = FIELD_LENGTH / 2
const ALLIANCE_ZONE_DEPTH = 158.6 * IN // 4.028 m (5.3)
const HUB_BASE = 47 * IN // 1.194 m square (5.4)
const HUB_OPENING = 41.7 * IN // 1.059 m flat to flat: the hexagonal opening at the rim (5.4)
const HUB_RIM = CAD_FUNNEL.rimZ // 1.829 m (72 in), the funnel's top edge above the carpet
/** HUB center, CAD: 3.6449 m from the middle of the field (the manual's 158.6 in to the near face plus half the base, 4.625 m, agrees to 0.5 mm). */
const HUB_X = FIELD_LENGTH / 2 - 3.6449
const HUB_Y = FIELD_WIDTH / 2
/** The funnel narrows to a hexagonal throat (apothem 0.303 m) 0.395 m below the rim. FUEL that passes it is inside the HUB. */
const THROAT_Z = CAD_FUNNEL.throatZ
const SENSOR_Z = THROAT_Z - 0.07 // ASSUMED: where the HUB's sensors read, a little below the throat (the CAD does not show the array)
const GUARDRAIL_H = 20 * IN // 0.508 m (5.2)
const WALL_H = 1.9875 // CAD: the top rail of the alliance wall
/** TRENCH (5.6): 65.65 in wide, 47.0 in deep, 40.25 in tall; 50.34 in wide and 22.25 in tall clear under each arm (the CAD agrees). Four of them, between each guardrail and the BUMP beside the HUB. */
const TRENCH = { width: 65.65 * IN, depth: 47.0 * IN, height: 40.25 * IN, clearWidth: 50.34 * IN, clearHeight: 22.25 * IN }
/** BUMP (5.5), CAD: a gable 1.1277 m along x and 1.8563 m along y, 0.1654 m at the crest; its centre line is 1.5222 m from the HUB's. */
const BUMP = { width: 1.8563, depth: 1.1277, height: 0.1654 }
const BUMP_Y = 1.5222
const BUMP_EDGE = CAD_BUMP_RIDGE[0][1] // the plastic is 15 mm high at its low edges
const DEPOT = { width: 42 * IN, depth: 27 * IN } // 5.7
const DEPOT_WALL = 0.0286 // CAD: the depot's barrier
/** TOWER (5.8), CAD: a base 1.1446 m deep (from the wall) and 1.2509 m wide, 0.914 m tall, with two uprights 1.832 m tall at its field-side edge. Blue's, centred on y = 3.7456; red's is the same turned half a circle. */
const TOWER = { depth: 1.1446, y0: 3.1201, y1: 4.371, baseH: 0.9144, uprightX: [1.0176, 1.1067], uprightY: [[3.1487, 3.3357], [4.1550, 4.3425]], uprightH: 1.832 }

/** FUEL: 5.91 in, 0.203 to 0.227 kg (5.10); bounce and friction are not stated, so these are calibration guesses (M12). */
export const FUEL: PieceSpec = {
  id: 'ball', radius: 0.075, mass: 0.215, friction: 0.6, restitution: 0.55, dragCoefficient: 0.47, rollingDamping: 2.0,
  magnus: { gain: 1.2, max: 0.4 },
  restitutionCurve: [[0, 1], [4, 0.9], [10, 0.7], [20, 0.5]],
  color: 0xffd23a,
}

/** Match periods, 6.4 Table 6-2, plus the 3 s scoring delay between AUTO and TELEOP. */
export const PHASES = [
  { name: 'auto', duration: 20 },
  { name: 'delay', duration: 3 },
  { name: 'transition', duration: 10 },
  { name: 'shift1', duration: 25 },
  { name: 'shift2', duration: 25 },
  { name: 'shift3', duration: 25 },
  { name: 'shift4', duration: 25 },
  { name: 'endgame', duration: 30 },
  { name: 'ended', duration: Infinity },
]
const AFTER_DEACTIVATION_GRACE = 3 // 6.5: assessment continues 3 s after a HUB deactivates and after the clock reaches 0:00
const MINOR = 5
const MAJOR = 15 // 6.6 Table 6-6

export function phaseAt(t: number): string {
  let acc = 0
  for (const p of PHASES) { acc += p.duration; if (t < acc) return p.name }
  return 'ended'
}

const other = (a: Alliance): Alliance => (a === 'blue' ? 'red' : 'blue')

/** Whether a HUB is active (6.4.1, Table 6-3). `firstInactive` is the alliance whose HUB is inactive in SHIFT 1 (the AUTO winner). */
export function hubActive(alliance: Alliance, phase: string, firstInactive: Alliance | null): boolean {
  switch (phase) {
    case 'auto': case 'delay': case 'transition': case 'endgame': return true
    case 'shift1': case 'shift3': return firstInactive === null ? true : alliance !== firstInactive
    case 'shift2': case 'shift4': return firstInactive === null ? true : alliance === firstInactive
    default: return false // ended
  }
}

/** Counts when the HUB is active now or was within the last 3 s (the processing-time grace of 6.5). */
export function counts(alliance: Alliance, t: number, firstInactive: Alliance | null): boolean {
  return hubActive(alliance, phaseAt(t), firstInactive) || hubActive(alliance, phaseAt(Math.max(0, t - AFTER_DEACTIVATION_GRACE)), firstInactive)
}

interface Respawn { t: number; kind: 'hub' | 'out'; alliance: Alliance; x: number; y: number }

interface RebuiltState extends Record<string, unknown> {
  autoFuel: Record<Alliance, number>
  fuel: Record<Alliance, number>
  firstInactive: Alliance | null
  pending: Respawn[]
  g403: number
  g407: number
  g403Latched: boolean
  lastG407: number
}

function fresh(): RebuiltState {
  return {
    autoFuel: { red: 0, blue: 0, none: 0 }, fuel: { red: 0, blue: 0, none: 0 }, firstInactive: null, pending: [],
    g403: 0, g407: 0, g403Latched: false, lastG407: -1e9,
  }
}

function st(ctx: { state: Record<string, unknown> }): RebuiltState {
  const s = ctx.state as Partial<RebuiltState>
  if (!s.pending) Object.assign(ctx.state, fresh())
  return ctx.state as RebuiltState
}

/** Corner points of the robot's bumper rectangle in the field. */
function corners(r: GameContext['robot']): [number, number][] {
  const c = Math.cos(r.yaw)
  const s = Math.sin(r.yaw)
  return ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sy]) => [r.x + c * sx * r.half[0] - s * sy * r.half[1], r.y + s * sx * r.half[0] + c * sy * r.half[1]])
}

/** The ALLIANCE ZONE of an alliance as an x range. */
function zone(a: Alliance): [number, number] {
  return a === 'blue' ? [0, ALLIANCE_ZONE_DEPTH] : [FIELD_LENGTH - ALLIANCE_ZONE_DEPTH, FIELD_LENGTH]
}

/** Where a vacuum-ballistic launch crosses the rim plane going down, or null if it never gets there. */
function rimCrossing(p: Vec3, v: Vec3): { x: number; y: number } | null {
  // z(t) = z0 + vz t - g t^2 / 2 = rim, take the later root (descending)
  const g = 9.81
  const a = -g / 2
  const b = v[2]
  const c = p[2] - HUB_RIM
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t <= 0) return null
  return { x: p[0] + v[0] * t, y: p[1] + v[1] * t }
}

/** The bounding box of some corner points, as a collider's center and half. */
function bounds(pts: Vec3[]): { center: Vec3; half: Vec3 } {
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])))
  const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])))
  return { center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], half: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] }
}

/** The six sloped walls of a HUB's funnel, each a thin convex slab whose inner face is the CAD's surface (a hexagonal frustum, vertices on the X axis). */
function funnelWalls(label: string, hx: number): BoxSpec[] {
  const { throatZ: z0, rimZ: z1, apothemAtThroat: a0, rimApothem: a1 } = CAD_FUNNEL
  const t = 0.02
  const R = (a: number): number => a / Math.cos(Math.PI / 6) // circumradius of a hexagon with this apothem
  const out: BoxSpec[] = []
  for (let i = 0; i < 6; i++) {
    const th0 = (i * Math.PI) / 3
    const th1 = ((i + 1) * Math.PI) / 3
    const mid = th0 + Math.PI / 6
    const v = (th: number, a: number, z: number): Vec3 => [hx + R(a) * Math.cos(th), HUB_Y + R(a) * Math.sin(th), z]
    const inner: Vec3[] = [v(th0, a0, z0), v(th1, a0, z0), v(th1, a1, z1), v(th0, a1, z1)]
    const outer: Vec3[] = inner.map((p) => [p[0] + Math.cos(mid) * t, p[1] + Math.sin(mid) * t, p[2]] as Vec3)
    const hull = [...inner, ...outer]
    out.push({ label: `${label} funnel ${i}`, ...bounds(hull), hull, friction: 0.5, restitution: 0.7 })
  }
  return out
}

/** One HUB: the solid lower body, a hollow shell with a roof under the funnel, and the funnel itself. FUEL that falls through the throat is the sensor's. */
function hubColliders(a: Alliance, hx: number): BoxSpec[] {
  const h = HUB_BASE / 2
  const wallT = 0.04
  const lowTop = 1.28 // the body panels end at 1.273 m
  const roof = 1.515 // CAD: the roof of the HUB
  const hole = 0.37 // the roof's opening around the funnel
  const zc = (lowTop + roof) / 2
  const hz = (roof - lowTop) / 2
  const mat = { friction: 0.5, restitution: 0.8 }
  return [
    { label: `hub ${a} body`, center: [hx, HUB_Y, lowTop / 2], half: [h, h, lowTop / 2], ...mat },
    { label: `hub ${a} shell front`, center: [hx + h - wallT / 2, HUB_Y, zc], half: [wallT / 2, h, hz], ...mat },
    { label: `hub ${a} shell back`, center: [hx - h + wallT / 2, HUB_Y, zc], half: [wallT / 2, h, hz], ...mat },
    { label: `hub ${a} shell left`, center: [hx, HUB_Y + h - wallT / 2, zc], half: [h - wallT, wallT / 2, hz], ...mat },
    { label: `hub ${a} shell right`, center: [hx, HUB_Y - h + wallT / 2, zc], half: [h - wallT, wallT / 2, hz], ...mat },
    { label: `hub ${a} roof front`, center: [hx + (hole + h) / 2, HUB_Y, roof - 0.015], half: [(h - hole) / 2, h, 0.015], ...mat },
    { label: `hub ${a} roof back`, center: [hx - (hole + h) / 2, HUB_Y, roof - 0.015], half: [(h - hole) / 2, h, 0.015], ...mat },
    { label: `hub ${a} roof left`, center: [hx, HUB_Y + (hole + h) / 2, roof - 0.015], half: [hole, (h - hole) / 2, 0.015], ...mat },
    { label: `hub ${a} roof right`, center: [hx, HUB_Y - (hole + h) / 2, roof - 0.015], half: [hole, (h - hole) / 2, 0.015], ...mat },
    ...funnelWalls(`hub ${a}`, hx),
  ]
}

/** A TOWER: the base and the two uprights. Blue's is at the blue wall; red's is blue's turned half a circle about the middle of the field. */
function towerColliders(a: Alliance): BoxSpec[] {
  const flip = a === 'red'
  const X = (x: number): number => (flip ? FIELD_LENGTH - x : x)
  const Y = (y: number): number => (flip ? FIELD_WIDTH - y : y)
  const box = (label: string, x0: number, x1: number, y0: number, y1: number, h: number, robotPass = false): BoxSpec => {
    const xs = [X(x0), X(x1)].sort((p, q) => p - q)
    const ys = [Y(y0), Y(y1)].sort((p, q) => p - q)
    return { label: `tower ${a} ${label}`, center: [(xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2, h / 2], half: [(xs[1] - xs[0]) / 2, (ys[1] - ys[0]) / 2, h / 2], friction: 0.5, restitution: 0.5, robotPass }
  }
  return [
    box('base', 0, TOWER.depth, TOWER.y0, TOWER.y1, TOWER.baseH),
    box('upright 1', TOWER.uprightX[0], TOWER.uprightX[1], TOWER.uprightY[0][0], TOWER.uprightY[0][1], TOWER.uprightH),
    box('upright 2', TOWER.uprightX[0], TOWER.uprightX[1], TOWER.uprightY[1][0], TOWER.uprightY[1][1], TOWER.uprightH),
  ]
}

/** A DEPOT's barrier: three low walls round its floor (the fourth side is the alliance wall). Robots drive over them. */
function depotColliders(a: Alliance): BoxSpec[] {
  const blue = a === 'blue'
  const cy = blue ? FIELD_WIDTH - 2.104 : 2.104 // the CAD's depot centre: blue's is on the +y side, red's the same turned half a circle
  const x0 = blue ? 0 : FIELD_LENGTH - DEPOT.depth
  const t = 0.025
  const hh = DEPOT_WALL / 2
  const front = blue ? x0 + DEPOT.depth : x0
  return [
    { label: `depot ${a} front`, center: [front + (blue ? -t / 2 : t / 2), cy, hh], half: [t / 2, DEPOT.width / 2, hh], friction: 0.5, restitution: 0.5, robotPass: true },
    { label: `depot ${a} side +`, center: [x0 + DEPOT.depth / 2, cy + DEPOT.width / 2 - t / 2, hh], half: [DEPOT.depth / 2, t / 2, hh], friction: 0.5, restitution: 0.5, robotPass: true },
    { label: `depot ${a} side -`, center: [x0 + DEPOT.depth / 2, cy - DEPOT.width / 2 + t / 2, hh], half: [DEPOT.depth / 2, t / 2, hh], friction: 0.5, restitution: 0.5, robotPass: true },
  ]
}

function fieldDefinition(): { colliders: BoxSpec[]; sensors: SensorSpec[] } {
  const colliders: BoxSpec[] = [
    { label: 'floor', center: [FIELD_LENGTH / 2, FIELD_WIDTH / 2, -0.1], half: [FIELD_LENGTH / 2 + 1, FIELD_WIDTH / 2 + 1, 0.1], friction: 0.8, restitution: 1 },
    // guardrails along the long edges (20 in), alliance walls at the ends (1.99 m: the top rail)
    { label: 'guardrail -y', center: [FIELD_LENGTH / 2, -0.025, GUARDRAIL_H / 2], half: [FIELD_LENGTH / 2, 0.025, GUARDRAIL_H / 2], friction: 0.4, restitution: 0.9 },
    { label: 'guardrail +y', center: [FIELD_LENGTH / 2, FIELD_WIDTH + 0.025, GUARDRAIL_H / 2], half: [FIELD_LENGTH / 2, 0.025, GUARDRAIL_H / 2], friction: 0.4, restitution: 0.9 },
    { label: 'alliance wall blue', center: [-0.05, FIELD_WIDTH / 2, WALL_H / 2], half: [0.05, FIELD_WIDTH / 2, WALL_H / 2], friction: 0.4, restitution: 0.9 },
    { label: 'alliance wall red', center: [FIELD_LENGTH + 0.05, FIELD_WIDTH / 2, WALL_H / 2], half: [0.05, FIELD_WIDTH / 2, WALL_H / 2], friction: 0.4, restitution: 0.9 },
  ]
  const sensors: SensorSpec[] = []
  for (const a of ['blue', 'red'] as const) {
    const hx = a === 'blue' ? HUB_X : FIELD_LENGTH - HUB_X
    colliders.push(...hubColliders(a, hx), ...towerColliders(a), ...depotColliders(a))
    sensors.push({ id: `hub-${a}`, center: [hx, HUB_Y, SENSOR_Z], half: [0.27, 0.27, 0.06], alliance: a })
    // two TRENCHES, one on each side of the field at the HUB's x: a post at each end (the guardrail's and the BUMP's) and an arm across the top that robots drive under
    // (the arm is above the robot's collision box, which is only bumper high, so it is a robotPass body: FUEL hits it, robots do not). Flush against the guardrail, centred on the HUB's x like the BUMPS.
    for (const side of [-1, 1]) {
      const post = (TRENCH.width - TRENCH.clearWidth) / 2
      const edge = HUB_Y + side * FIELD_WIDTH / 2 // the guardrail's inner face
      const inner = edge - side * TRENCH.width // the BUMP end
      const th = TRENCH.height
      const label = `trench ${a} ${side > 0 ? 'left' : 'right'}`
      colliders.push(
        { label: `${label} post (guardrail)`, center: [hx, edge - side * post / 2, th / 2], half: [TRENCH.depth / 2, post / 2, th / 2], friction: 0.5, restitution: 0.6 },
        { label: `${label} post (bump)`, center: [hx, inner + side * post / 2, th / 2], half: [TRENCH.depth / 2, post / 2, th / 2], friction: 0.5, restitution: 0.6 },
        { label: `${label} arm`, center: [hx, (edge + inner) / 2, (TRENCH.clearHeight + th) / 2], half: [TRENCH.depth / 2, TRENCH.width / 2, (th - TRENCH.clearHeight) / 2], friction: 0.5, restitution: 0.6, robotPass: true },
      )
    }
    // two BUMPS beside the HUB: a gable (the CAD's ridge) with ramps; pieces collide with the hull, the robot's tires follow bumpHeight() (terrain below)
    for (const side of [-1, 1]) {
      const cy = HUB_Y + side * BUMP_Y
      const x0 = hx - BUMP.depth / 2
      const x1 = hx + BUMP.depth / 2
      const y0 = cy - BUMP.width / 2
      const y1 = cy + BUMP.width / 2
      const e = BUMP_EDGE
      colliders.push({
        label: `bump ${a} ${side > 0 ? 'left' : 'right'}`, center: [hx, cy, BUMP.height / 2], half: [BUMP.depth / 2, BUMP.width / 2, BUMP.height / 2], friction: 0.7, restitution: 0.6, robotPass: true,
        hull: [
          [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
          [x0, y0, e], [x1, y0, e], [x1, y1, e], [x0, y1, e],
          [hx, y0, BUMP.height], [hx, y1, BUMP.height],
        ],
      })
    }
  }
  // FUEL that leaves the field is put back by field staff (6.8): catch it in zones just outside the guardrails and above the alliance walls
  sensors.push(
    { id: 'out-left', center: [FIELD_LENGTH / 2, -0.6, 1.5], half: [FIELD_LENGTH / 2 + 1, 0.5, 1.5], alliance: 'none' },
    { id: 'out-right', center: [FIELD_LENGTH / 2, FIELD_WIDTH + 0.6, 1.5], half: [FIELD_LENGTH / 2 + 1, 0.5, 1.5], alliance: 'none' },
    { id: 'out-end-blue', center: [-0.8, FIELD_WIDTH / 2, 2.0], half: [0.5, FIELD_WIDTH / 2 + 1, 2.0], alliance: 'none' },
    { id: 'out-end-red', center: [FIELD_LENGTH + 0.8, FIELD_WIDTH / 2, 2.0], half: [0.5, FIELD_WIDTH / 2 + 1, 2.0], alliance: 'none' },
  )
  return { colliders, sensors }
}

/**
 * Where every FUEL starts, from the CAD: 360 in the neutral zone (a 12 by 30 grid, one layer) and 24 in each DEPOT (4 by 6). The two CHUTES (24 each)
 * sit behind the alliance walls and other robots' preloads are not modeled. A smaller count takes a random subset of the neutral grid.
 */
function layout(rng: () => number, preload: number, neutralFuel: number): PieceSpawn[] {
  const out: PieceSpawn[] = []
  const cells = CAD_NEUTRAL.map((c) => [c[0], c[1]] as [number, number])
  const total = Math.max(0, Math.min(cells.length, neutralFuel) - preload)
  // keep a deterministic subset when there are more cells than balls
  for (let k = cells.length - 1; k > 0; k--) { const r = Math.floor(rng() * (k + 1)); const t = cells[k]; cells[k] = cells[r]; cells[r] = t }
  for (const c of cells.slice(0, total)) {
    out.push({ spec: 'ball', asleep: true, position: [c[0] + (rng() - 0.5) * 0.002, c[1] + (rng() - 0.5) * 0.002, FUEL.radius] })
  }
  for (const depot of [CAD_DEPOT_BLUE, CAD_DEPOT_RED]) {
    for (const c of depot) out.push({ spec: 'ball', asleep: true, position: [c[0], c[1], FUEL.radius] })
  }
  return out
}

function foul(s: RebuiltState, who: Alliance, points: number, reason: string, ctx: GameContext, kind: 'g403' | 'g407'): Score {
  if (kind === 'g403') s.g403++
  else { s.g407++; s.lastG407 = ctx.time }
  return { alliance: who, points, reason }
}

/**
 * preload: FUEL the robot holds at the start (taken out of the neutral zone count).
 * neutralFuel: FUEL in the neutral zone, 360 on the CAD's field (6.3.4: 360 to 408 depending on preloads). The simulator can lower it to keep
 * real-time play smooth, see rules/REBUILT_RULES_EXTRACT.md section 7.
 */
export function createRebuiltGame(opts: { preload?: number; neutralFuel?: number } = {}): GameModule {
  const { colliders, sensors } = fieldDefinition()
  const preload = opts.preload ?? 0
  const neutralFuel = opts.neutralFuel ?? CAD_NEUTRAL.length
  return {
    id: 'game-rebuilt',
    field: () => ({ length: FIELD_LENGTH, width: FIELD_WIDTH, colliders, sensors }),
    pieces: () => [FUEL],
    initialLayout: (rng) => layout(rng, preload, neutralFuel),
    matchFlow: () => ({ phases: PHASES }),

    onEvent: (e: GameEvent, ctx: GameContext): Score[] => {
      const s = st(ctx)
      if (e.type === 'phase-changed' && e.to === 'transition' && s.firstInactive === null) {
        // the AUTO winner's HUB is inactive first; a tie is broken at random (6.4.1)
        const b = s.autoFuel.blue
        const r = s.autoFuel.red
        s.firstInactive = b > r ? 'blue' : r > b ? 'red' : (ctx.rng() < 0.5 ? 'blue' : 'red')
        return []
      }
      if (e.type === 'piece-entered-sensor') {
        const id = e.sensor.id
        if (id.startsWith('hub-')) {
          const owner = e.sensor.alliance
          ctx.removePiece(e.pieceId)
          // processed FUEL comes back out of one of four exits facing the NEUTRAL ZONE after a short delay (ASSUMED timing and positions)
          const sign = owner === 'blue' ? 1 : -1
          const hx = owner === 'blue' ? HUB_X : FIELD_LENGTH - HUB_X
          const exitY = HUB_Y + ([-0.45, -0.15, 0.15, 0.45][Math.floor(ctx.rng() * 4)] ?? 0)
          s.pending.push({ t: ctx.time + 0.5 + ctx.rng() * 1.0, kind: 'hub', alliance: owner, x: hx + sign * (HUB_BASE / 2 + FUEL.radius + 0.05), y: exitY })
          if (ctx.phase === 'ended' && ctx.time > PHASES.slice(0, 8).reduce((a, p) => a + p.duration, 0) + AFTER_DEACTIVATION_GRACE) return []
          if (!counts(owner, ctx.time, s.firstInactive)) return []
          s.fuel[owner]++
          const auto = ctx.phase === 'auto' || ctx.phase === 'delay'
          if (auto) s.autoFuel[owner]++
          return [{ alliance: owner, points: 1, reason: `FUEL in ${owner} HUB (${auto ? 'auto' : 'teleop'})` }]
        }
        if (id.startsWith('out-')) {
          ctx.removePiece(e.pieceId)
          s.pending.push({ t: ctx.time + 1.5, kind: 'out', alliance: 'none', x: 0, y: id === 'out-left' ? 0.35 : id === 'out-right' ? FIELD_WIDTH - 0.35 : FIELD_WIDTH / 2 })
          return []
        }
      }
      if (e.type === 'piece-launched') {
        // G407: launch into your HUB only with your bumpers partly in your ALLIANCE ZONE (read here as: a launch whose path
        // comes down through your own HUB opening, from a robot that is entirely outside your ALLIANCE ZONE)
        const a = ctx.robot.alliance
        const [z0, z1] = zone(a)
        const xs = corners(ctx.robot).map((c) => c[0])
        const inZone = Math.min(...xs) <= z1 && Math.max(...xs) >= z0
        if (!inZone && ctx.time - s.lastG407 > 3 && phaseAt(ctx.time) !== 'ended') {
          const cross = rimCrossing(e.position, e.velocity)
          const hx = a === 'blue' ? HUB_X : FIELD_LENGTH - HUB_X
          if (cross && Math.abs(cross.x - hx) < HUB_OPENING / 2 + 0.25 && Math.abs(cross.y - HUB_Y) < HUB_OPENING / 2 + 0.25) {
            return [foul(s, other(a), MAJOR, 'G407: launched into own HUB from outside the ALLIANCE ZONE', ctx, 'g407')]
          }
        }
      }
      return []
    },

    onTick: (ctx: GameContext): Score[] => {
      const s = st(ctx)
      const out: Score[] = []
      // timed respawns: FUEL out of HUB exits, and FUEL put back after leaving the field
      if (s.pending.length > 0 && s.pending.some((p) => p.t <= ctx.time)) {
        const due = s.pending.filter((p) => p.t <= ctx.time)
        s.pending = s.pending.filter((p) => p.t > ctx.time)
        for (const p of due) {
          if (p.kind === 'hub') {
            const sign = p.alliance === 'blue' ? 1 : -1
            ctx.spawn({ spec: 'ball', position: [p.x, p.y, 0.12], velocity: [sign * (1.2 + ctx.rng() * 0.8), (ctx.rng() - 0.5) * 0.6, 0] })
          } else {
            ctx.spawn({ spec: 'ball', position: [FIELD_LENGTH / 2 + (ctx.rng() - 0.5) * 6, p.y, 0.2] })
          }
        }
      }
      // G403: in AUTO a robot may not completely cross the CENTER LINE (bumpers completely across)
      if (ctx.phase === 'auto') {
        const xs = corners(ctx.robot).map((c) => c[0])
        const a = ctx.robot.alliance
        const across = a === 'blue' ? Math.min(...xs) > CENTER_LINE : Math.max(...xs) < CENTER_LINE
        if (across && !s.g403Latched) {
          s.g403Latched = true
          out.push(foul(s, other(a), MAJOR, 'G403: completely crossed the CENTER LINE in AUTO', ctx, 'g403'))
        } else if (!across) s.g403Latched = false
      }
      return out
    },

    gameData: (state, time) => gameDataChar(state, time),
    status: (state, time) => {
      const s = state as Partial<RebuiltState>
      const fi = s.firstInactive ?? null
      const ph = phaseAt(time)
      const active = (a: Alliance): string => (hubActive(a, ph, fi) ? 'active' : 'INACTIVE')
      const gameData = fi === null ? '' : fi === 'red' ? 'R' : 'B'
      return {
        hubs: `blue ${active('blue')}   red ${active('red')}`,
        fuel: `blue ${s.fuel?.blue ?? 0}   red ${s.fuel?.red ?? 0}   (auto ${s.autoFuel?.blue ?? 0} / ${s.autoFuel?.red ?? 0})`,
        gameData: gameData === '' ? 'not sent yet' : gameData,
        fouls: `G403 ${s.g403 ?? 0}   G407 ${s.g407 ?? 0}`,
      }
    },
    hud: () => ({ title: 'REBUILT' }),
    terrain: bumpHeight,
  }
}

/** Floor height: the BUMPS beside each HUB (the CAD's gable: 15 mm at the low edges, 0.1654 m at the crest, linear between), zero elsewhere. */
export function bumpHeight(x: number, y: number): number {
  for (const hx of [HUB_X, FIELD_LENGTH - HUB_X]) {
    const dx = Math.abs(x - hx)
    if (dx >= BUMP.depth / 2) continue
    for (const side of [-1, 1]) {
      const cy = HUB_Y + side * BUMP_Y
      if (Math.abs(y - cy) > BUMP.width / 2) continue
      return BUMP_EDGE + (BUMP.height - BUMP_EDGE) * (1 - dx / (BUMP.depth / 2))
    }
  }
  return 0
}

/** The character the robot receives as Game Data: the alliance whose HUB goes inactive first (WPILib 2026 game data), or '' before it is sent. */
export function gameDataChar(state: Record<string, unknown>, time: number): string {
  const s = state as Partial<RebuiltState>
  if (!s.firstInactive || time < 23) return ''
  return s.firstInactive === 'red' ? 'R' : 'B'
}

export { BUMP, TRENCH, MINOR, HUB_X, HUB_Y, HUB_OPENING, HUB_RIM, CENTER_LINE, ALLIANCE_ZONE_DEPTH }
