// REBUILT (2026): the field, FUEL, match flow, HUB activation, scoring and the two fouls the user asked for (G403 and G407).
// Every rule here is taken from rules/REBUILT_RULES_EXTRACT.md, which lists the section of the game manual for each fact and
// marks what is inferred. Geometry that the manual only gives in the Field Dimension Drawings (HUB height, exits, depot and
// trench positions) is assumed and marked ASSUMED below. Coordinates: origin at the blue wall corner, +X toward the red wall.
import type {
  Alliance, BoxSpec, GameContext, GameEvent, GameModule, PieceSpawn, PieceSpec, Score, SensorSpec, Vec3,
} from '../engine/types'

const IN = 0.0254
export const FIELD_LENGTH = 651.2 * IN // 16.54 m (manual 5.2; which dimension is which is inferred from 5.3)
export const FIELD_WIDTH = 317.7 * IN // 8.07 m
const CENTER_LINE = FIELD_LENGTH / 2
const ALLIANCE_ZONE_DEPTH = 158.6 * IN // 4.028 m (5.3)
const HUB_BASE = 47 * IN // 1.194 m (5.4)
const HUB_OPENING = 41.7 * IN // 1.059 m hexagon, modeled as a square of the same width (5.4)
const HUB_RIM = 72 * IN // 1.829 m, front edge of the opening above the carpet (5.4)
/** HUB center: the manual puts it 158.6 in from the alliance wall, read as the near face (the robot code's 4.6 agrees). Assumed. */
const HUB_X = ALLIANCE_ZONE_DEPTH + HUB_BASE / 2
const HUB_Y = FIELD_WIDTH / 2
const HUB_HEIGHT = HUB_RIM // ASSUMED: the overall height is only in the drawings; the body is modeled up to the rim
const SENSOR_Z = HUB_RIM - 0.23 // ASSUMED: the depth of the sensor array below the opening
const GUARDRAIL_H = 20 * IN // 0.508 m (5.2)
const BUMP = { width: 73 * IN, depth: 44.4 * IN, height: 6.513 * IN } // 5.5
const DEPOT = { width: 42 * IN, depth: 27 * IN } // 5.7

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

function fieldDefinition(): { colliders: BoxSpec[]; sensors: SensorSpec[] } {
  const colliders: BoxSpec[] = [
    { label: 'floor', center: [FIELD_LENGTH / 2, FIELD_WIDTH / 2, -0.1], half: [FIELD_LENGTH / 2 + 1, FIELD_WIDTH / 2 + 1, 0.1], friction: 0.8, restitution: 1 },
    // guardrails along the long edges (20 in), alliance walls at the ends (modeled tall so FUEL stays on the field)
    { label: 'guardrail -y', center: [FIELD_LENGTH / 2, -0.025, GUARDRAIL_H / 2], half: [FIELD_LENGTH / 2, 0.025, GUARDRAIL_H / 2], friction: 0.4, restitution: 0.9 },
    { label: 'guardrail +y', center: [FIELD_LENGTH / 2, FIELD_WIDTH + 0.025, GUARDRAIL_H / 2], half: [FIELD_LENGTH / 2, 0.025, GUARDRAIL_H / 2], friction: 0.4, restitution: 0.9 },
    { label: 'alliance wall blue', center: [-0.05, FIELD_WIDTH / 2, 1.25], half: [0.05, FIELD_WIDTH / 2, 1.25], friction: 0.4, restitution: 0.9 },
    { label: 'alliance wall red', center: [FIELD_LENGTH + 0.05, FIELD_WIDTH / 2, 1.25], half: [0.05, FIELD_WIDTH / 2, 1.25], friction: 0.4, restitution: 0.9 },
  ]
  const sensors: SensorSpec[] = []
  for (const a of ['blue', 'red'] as const) {
    const hx = a === 'blue' ? HUB_X : FIELD_LENGTH - HUB_X
    // the HUB: four walls around the opening, hollow, up to the rim
    const wall = (HUB_BASE - HUB_OPENING) / 2
    const o = HUB_BASE / 2 - wall / 2
    const hz = HUB_HEIGHT / 2
    colliders.push(
      { label: `hub ${a} front`, center: [hx + o, HUB_Y, hz], half: [wall / 2, HUB_BASE / 2, hz], friction: 0.5, restitution: 0.8 },
      { label: `hub ${a} back`, center: [hx - o, HUB_Y, hz], half: [wall / 2, HUB_BASE / 2, hz], friction: 0.5, restitution: 0.8 },
      { label: `hub ${a} left`, center: [hx, HUB_Y + o, hz], half: [HUB_BASE / 2, wall / 2, hz], friction: 0.5, restitution: 0.8 },
      { label: `hub ${a} right`, center: [hx, HUB_Y - o, hz], half: [HUB_BASE / 2, wall / 2, hz], friction: 0.5, restitution: 0.8 },
    )
    sensors.push({ id: `hub-${a}`, center: [hx, HUB_Y, SENSOR_Z], half: [HUB_OPENING / 2 - 0.05, HUB_OPENING / 2 - 0.05, 0.08], alliance: a })
    // two BUMPS beside the HUB: a ridge with 15-degree-ish ramps; the robot drives through (it cannot climb yet, M7)
    for (const side of [-1, 1]) {
      const cy = HUB_Y + side * (HUB_BASE / 2 + BUMP.width / 2)
      const x0 = hx - BUMP.depth / 2
      const x1 = hx + BUMP.depth / 2
      const y0 = cy - BUMP.width / 2
      const y1 = cy + BUMP.width / 2
      const h = BUMP.height
      colliders.push({
        label: `bump ${a} ${side > 0 ? 'left' : 'right'}`, center: [hx, cy, h / 2], half: [BUMP.depth / 2, BUMP.width / 2, h / 2], friction: 0.7, restitution: 0.6, robotPass: true,
        hull: [
          [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
          [hx - 0.05, y0, h], [hx + 0.05, y0, h], [hx + 0.05, y1, h], [hx - 0.05, y1, h],
        ],
      })
    }
  }
  // FUEL that leaves the field is put back by field staff (6.8): catch it in zones just outside the guardrails
  sensors.push(
    { id: 'out-left', center: [FIELD_LENGTH / 2, -0.6, 1.5], half: [FIELD_LENGTH / 2 + 1, 0.5, 1.5], alliance: 'none' },
    { id: 'out-right', center: [FIELD_LENGTH / 2, FIELD_WIDTH + 0.6, 1.5], half: [FIELD_LENGTH / 2 + 1, 0.5, 1.5], alliance: 'none' },
  )
  return { colliders, sensors }
}

/** 504 FUEL (6.3.4): 24 per DEPOT, the rest in the neutral zone pile; the two CHUTES (24 each) and other robots' preloads are not modeled. */
function layout(rng: () => number, preload: number, neutralFuel: number): PieceSpawn[] {
  const out: PieceSpawn[] = []
  const spacing = 2 * FUEL.radius + 0.004
  // neutral zone pile: 5.23 m along Y by 1.83 m along X, one layer in hexagonal packing (rows offset by half a ball), jittered
  const rowStep = spacing * Math.sqrt(3) / 2
  const rows = Math.floor((72 * IN - 2 * FUEL.radius) / rowStep) + 1
  const perRow = Math.floor((206 * IN - spacing / 2) / spacing)
  const total = Math.max(0, Math.min(408, neutralFuel) - preload)
  const cells: [number, number, number][] = []
  for (let i = 0; i < rows; i++) {
    const offset = i % 2 === 0 ? 0 : spacing / 2
    for (let j = 0; j < perRow; j++) cells.push([CENTER_LINE + (i - (rows - 1) / 2) * rowStep, HUB_Y + (j - (perRow - 1) / 2) * spacing + (offset - spacing / 4), 0])
  }
  // keep a deterministic subset when there are more cells than balls
  for (let k = cells.length - 1; k > 0; k--) { const r = Math.floor(rng() * (k + 1)); const t = cells[k]; cells[k] = cells[r]; cells[r] = t }
  for (const c of cells.slice(0, total)) {
    out.push({ spec: 'ball', asleep: true, position: [c[0] + (rng() - 0.5) * 0.002, c[1] + (rng() - 0.5) * 0.002, FUEL.radius] })
  }
  // DEPOTS: 24 FUEL each along the alliance wall. ASSUMED position (the drawings give it): blue at y = 2.0, red at the point-symmetric spot.
  for (const a of ['blue', 'red'] as const) {
    const cx = a === 'blue' ? DEPOT.depth / 2 : FIELD_LENGTH - DEPOT.depth / 2
    const cy = a === 'blue' ? 2.0 : FIELD_WIDTH - 2.0
    for (let k = 0; k < 24; k++) {
      const i = k % 4
      const j = Math.floor(k / 4)
      out.push({ spec: 'ball', asleep: true, position: [cx + (i - 1.5) * spacing * (a === 'blue' ? 1 : -1), cy + (j - 2.5) * spacing, FUEL.radius] })
    }
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
 * neutralFuel: FUEL in the neutral zone pile, 408 by the manual at most (6.3.4: 360 to 408 depending on preloads). The simulator can lower it to keep
 * real-time play smooth, see rules/REBUILT_RULES_EXTRACT.md section 7.
 */
export function createRebuiltGame(opts: { preload?: number; neutralFuel?: number } = {}): GameModule {
  const { colliders, sensors } = fieldDefinition()
  const preload = opts.preload ?? 0
  const neutralFuel = opts.neutralFuel ?? 408
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
          s.pending.push({ t: ctx.time + 1.5, kind: 'out', alliance: 'none', x: 0, y: id === 'out-left' ? 0.35 : FIELD_WIDTH - 0.35 })
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
  }
}

/** The character the robot receives as Game Data: the alliance whose HUB goes inactive first (WPILib 2026 game data), or '' before it is sent. */
export function gameDataChar(state: Record<string, unknown>, time: number): string {
  const s = state as Partial<RebuiltState>
  if (!s.firstInactive || time < 23) return ''
  return s.firstInactive === 'red' ? 'R' : 'B'
}

export { MINOR, HUB_X, HUB_Y, HUB_OPENING, HUB_RIM, CENTER_LINE, ALLIANCE_ZONE_DEPTH }
