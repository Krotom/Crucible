// The Crucible engine core: a fixed-step Rapier world, the game plug-in host, a scripted robot body, scoring and match
// flow, and bit-for-bit snapshots. No DOM, no wall clock: given the same config and the same number of steps the
// state is identical on every run (deterministic Rapier build, seeded RNG, fixed iteration order).
import RAPIER from '@dimforge/rapier3d-deterministic-compat'
import type { Collider, ColliderDesc, Cuboid, RigidBody, World } from '@dimforge/rapier3d-deterministic-compat'
import type { MotorState } from './bridge/frames'
import { BallSystem, type BallHost } from './balls'
import { BotController, type BotHost } from './bots'
import { PileManager, type PileHost } from './pile'
import { Drivetrain } from './drivetrain'
import { MechanismModel } from './mechanism'
import { Hasher, Rng } from './rng'
import type {
  Alliance, BoxSpec, EngineConfig, EngineTuning, OtherRobotSpec, EngineSnapshot, GameContext, GameEvent, GameModule, PieceSpawn, PieceSpec, RenderFrame,
  RobotSpec, Score, ScoreEntry, SensorSpec, Vec3,
} from './types'

// collision groups: the robot collides with the static field and pieces, not with robot-pass-through field parts
const GROUP_STATIC = 0x1
const GROUP_BALL = 0x2
const GROUP_ROBOT = 0x4
const GROUP_PASS = 0x8
const GRAVITY = 9.81
const AIR_DENSITY = 1.225
const SCORE_LOG_CAP = 200
const IMPACT_ACCEL = 25 // contact acceleration that counts as a contact in progress, m/s^2 (drive at full traction is about 12)
const IMPACT_QUIET_STEPS = 50 // one hit: the bumpers rebound and the drive pushes back in, which must not count as new hits
const IMPACT_MIN_SPEED = 0.3 // smallest speed change reported as an impact, m/s

let rapierReady: Promise<void> | null = null
/** Loads the Rapier WASM once per process or worker. */
export function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init()
  return rapierReady
}

/** x, y, z: the last position read for drawing (a resting piece does not move, so it is only re-read while awake) */
interface Piece { id: number; spec: PieceSpec; specIndex: number; handle: number; x: number; y: number; z: number }

/** Piecewise-linear interpolation of [x, y] points, clamped at the ends. */
export function interp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1]
      const [x1, y1] = points[i]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return points[points.length - 1][1]
}

function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
}

/** Rounded bumper corners as a chamfer: the convex footprint of half extents hx, hy with corners cut by c, from -hz to +hz. */
function chassisHull(hx: number, hy: number, hz: number, c: number): Float32Array {
  const k = Math.min(c, hx * 0.9, hy * 0.9)
  const ring: [number, number][] = [[hx, hy - k], [hx - k, hy], [-hx + k, hy], [-hx, hy - k], [-hx, -hy + k], [-hx + k, -hy], [hx - k, -hy], [hx, -hy + k]]
  const pts: number[] = []
  for (const z of [-hz, hz]) for (const [x, y] of ring) pts.push(x, y, z)
  return new Float32Array(pts)
}

/** Orientation from yaw, pitch (about left, nose down positive) and roll (about forward, left up positive): Rz * Ry * Rx. Returns w, x, y, z. */
function tiltQuat(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2)
  return [
    cy * cp * cr + sy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
  ]
}

/** Floor height and slope under a footprint: a plane through the heights at the contact points. gx, gy: slope in the field. */
interface Tilt { z: number; pitch: number; roll: number; gx: number; gy: number }
const FLAT: Tilt = { z: 0, pitch: 0, roll: 0, gx: 0, gy: 0 }

function insideBox(p: { x: number; y: number; z: number }, s: SensorSpec): boolean {
  const dx = p.x - s.center[0]
  const dy = p.y - s.center[1]
  const dz = p.z - s.center[2]
  const c = Math.cos(-(s.yaw ?? 0))
  const sn = Math.sin(-(s.yaw ?? 0))
  const lx = dx * c - dy * sn
  const ly = dx * sn + dy * c
  return Math.abs(lx) <= s.half[0] && Math.abs(ly) <= s.half[1] && Math.abs(dz) <= s.half[2]
}

export class Engine {
  readonly dt: number
  readonly game: GameModule
  readonly pieceSpecs: PieceSpec[]
  private specByName = new Map<string, number>()
  private robotSpec: RobotSpec
  private seed: number
  private solverIterations: number | undefined
  private tuning: EngineTuning
  private pile: PileManager | null = null
  private pieceById = new Map<number, Piece>()

  private world!: World
  private robot!: RigidBody
  private rng: Rng
  private pieces: Piece[] = []
  private pieceByHandle = new Map<number, Piece>()
  private captureShapes = new Map<string, Cuboid>()
  private nextPieceId = 1
  private stepCount = 0
  private sensorInside = new Map<string, Set<number>>()
  private scores: Record<Alliance, number> = { red: 0, blue: 0, none: 0 }
  private scoreLog: ScoreEntry[] = []
  private phaseIndex = -1
  private gameState: Record<string, unknown> = {}
  private removeQueue: number[] = []
  private scriptEnd = 0
  private others: { spec: OtherRobotSpec; body: RigidBody; collider: Collider; inertia: number; ctrl: BotController | null }[] = []
  private robotCollider!: Collider
  /** the force the tires and the slope put on the chassis last step (to tell contact forces from drive forces) */
  private driveForce = { fx: 0, fy: 0 }
  private robotMass = 1
  /** contact feedback: the speed change of a contact in progress, and the largest so far */
  private contact = { acc: 0, quiet: 0, peak: 0, count: 0, vx: 0, vy: 0, against: 'field' as 'field' | 'robot' }
  /** The swerve model when the robot is driven by motor voltages. */
  drivetrain: Drivetrain | null = null
  /** Mechanism physics by Talon CAN id. */
  readonly mechanisms = new Map<number, MechanismModel>()
  private mechanismVolts = new Map<number, number>()
  private mechanismByName = new Map<string, MechanismModel>()
  /** The hybrid ball model (intake capture, stages, shooter) when the robot has ball handling. */
  ballSystem: BallSystem | null = null

  private constructor(cfg: EngineConfig) {
    this.dt = cfg.dt ?? 0.001
    this.game = cfg.game
    this.robotSpec = cfg.robot
    this.seed = cfg.seed
    this.solverIterations = cfg.solverIterations
    this.tuning = cfg.tuning ?? {}
    this.rng = new Rng(cfg.seed)
    this.pieceSpecs = cfg.game.pieces()
    this.pieceSpecs.forEach((p, i) => this.specByName.set(p.id, i))
    this.drivetrain = cfg.robot.drivetrain ? new Drivetrain(cfg.robot.drivetrain) : null
    for (const m of cfg.robot.mechanisms ?? []) {
      const model = new MechanismModel(m)
      this.mechanisms.set(m.id, model)
      this.mechanismByName.set(m.name, model)
    }
    if (cfg.robot.balls) this.ballSystem = new BallSystem(cfg.robot.balls, this.ballHost())
    this.scriptEnd = cfg.robot.script.reduce((t, s) => t + s.duration, 0)
  }

  static async create(cfg: EngineConfig): Promise<Engine> {
    await initRapier()
    const e = new Engine(cfg)
    e.build()
    return e
  }

  get time(): number { return this.stepCount * this.dt }
  get steps(): number { return this.stepCount }
  get phase(): string { return this.phaseName() }
  private lastHash = ''

  /**
   * Adjusts physical values while the sim runs: tire friction and the shot (efficiency, backspin) act at once; robot mass and bumper friction
   * are read when the robot body is built, so they apply from the next reset().
   */
  tune(p: { mu?: number; mass?: number; efficiency?: number; backspin?: number; bumperFriction?: number }): void {
    if (this.drivetrain) {
      if (p.mu !== undefined) this.drivetrain.spec.mu = p.mu
      if (p.mass !== undefined) this.drivetrain.spec.mass = p.mass
    }
    this.ballSystem?.tuneShooter(p.efficiency, p.backspin)
    if (p.bumperFriction !== undefined) this.robotSpec.chassis = { ...this.robotSpec.chassis, friction: p.bumperFriction }
  }

  /** Estimated current drawn from the battery by the drivetrain and the mechanisms in the last step, amps. */
  batteryAmps(): number {
    let a = this.drivetrain?.currentAmps ?? 0
    for (const m of this.mechanisms.values()) a += m.supplyAmps
    return a
  }

  /** Frees the physics world (WebAssembly memory): call when an engine is thrown away, as the seed sweep does after every run. */
  dispose(): void { this.world?.free() }

  /** The alliance the simulated robot plays for. */
  /** The robot's ground position and heading right now (field frame). */
  robotGroundPose(): { x: number; y: number; yaw: number } {
    const t = this.robot.translation(), q = this.robot.rotation()
    return { x: t.x, y: t.y, yaw: 2 * Math.atan2(q.z, q.w) }
  }
  get robotAlliance(): Alliance { return this.robotSpec.alliance ?? 'blue' }

  /** The Game Data string the field system would send the robot now. */
  get gameData(): string { return this.game.gameData ? this.game.gameData(this.gameState, this.time) : '' }
  get scoreTotals(): Record<Alliance, number> { return { ...this.scores } }
  get log(): readonly ScoreEntry[] { return this.scoreLog }
  get pieceCount(): number { return this.pieces.length }
  /** pieces the pile manager holds as fixed bodies right now (0 without tuning.pile) */
  get frozenCount(): number { return this.pile?.frozen.size ?? 0 }
  get scriptDuration(): number { return this.scriptEnd }

  // ---------------------------------------------------------------- building

  /** (Re)creates the world from scratch: field, robot, initial pieces. */
  private build(): void {
    this.world?.free()
    this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY })
    this.world.timestep = this.dt
    this.applyTuning()
    this.pieces = []
    this.pieceByHandle.clear()
    this.pieceById.clear()
    this.pile = this.tuning.pile ? new PileManager(this.pileHost(), this.tuning.pile === true ? {} : this.tuning.pile) : null
    this.nextPieceId = 1
    this.stepCount = 0
    this.scores = { red: 0, blue: 0, none: 0 }
    this.scoreLog = []
    this.gameState = {}
    this.removeQueue = []
    this.sensorInside = new Map()

    const field = this.game.field()
    for (const b of field.colliders) this.addBox(b)
    for (const s of field.sensors) this.sensorInside.set(s.id, new Set())
    this.contact = { acc: 0, quiet: 0, peak: 0, count: 0, vx: 0, vy: 0, against: 'field' }
    this.driveForce = { fx: 0, fy: 0 }
    this.addRobot()
    this.addOthers()
    for (const spawn of this.game.initialLayout(this.rng.fn())) this.spawn(spawn)
    this.phaseIndex = -1
    this.updatePhase()
  }

  /** Starts over, optionally with a new seed. */
  reset(seed?: number): void {
    if (seed !== undefined) this.seed = seed
    this.rng = new Rng(this.seed)
    this.build()
  }

  private addBox(b: BoxSpec): void {
    let desc: ColliderDesc
    if (b.hull) {
      const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(b.hull.flat()))
      if (!hull) throw new Error(`Degenerate hull for ${b.label ?? 'collider'}`)
      desc = hull
    } else {
      desc = RAPIER.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
        .setTranslation(b.center[0], b.center[1], b.center[2])
        .setRotation(yawQuat(b.yaw ?? 0))
    }
    desc = desc
      .setCollisionGroups(((b.robotPass ? GROUP_PASS : GROUP_STATIC) << 16) | 0xffff)
      .setFriction(b.friction ?? 0.8)
      .setRestitution(b.restitution ?? 1)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
    this.world.createCollider(desc)
  }

  private addRobot(): void {
    const r = this.robotSpec
    const driven = this.drivetrain !== null
    this.drivetrain?.reset()
    for (const m of this.mechanisms.values()) m.reset()
    this.ballSystem?.reset()
    const desc = driven
      ? RAPIER.RigidBodyDesc.dynamic().enabledTranslations(true, true, false).enabledRotations(false, false, true).setCanSleep(false)
      : RAPIER.RigidBodyDesc.kinematicVelocityBased()
    const body = this.world.createRigidBody(desc.setTranslation(r.start.x, r.start.y, r.half[2]).setRotation(yawQuat(r.start.yaw)))
    const bumper = this.bumperCollider(r.half, driven ? this.drivetrain!.spec.mass : 0, r.chassis?.moi, driven)
    this.robotCollider = this.world.createCollider(bumper, body)
    this.robotMass = driven ? this.drivetrain!.spec.mass : 1
    this.robot = body
  }

  /**
   * A bumper collider: a chamfered footprint for driven robots (rounded bumper corners do not snag on walls and ramps), a plain box for
   * the scripted test robot. Mass and yaw inertia are set explicitly. Robots average their friction and restitution with each other
   * and multiply them with field surfaces, so bumper on wall and bumper on bumper both come out near the configured value.
   */
  private bumperCollider(half: Vec3, mass: number, moi: number | undefined, realistic: boolean): ColliderDesc {
    const ch = this.robotSpec.chassis ?? {}
    let desc = realistic
      ? (RAPIER.ColliderDesc.convexHull(chassisHull(half[0], half[1], half[2], ch.chamfer ?? 0.04)) as ColliderDesc)
      : RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2])
    if (realistic) {
      const i = moi ?? (mass * (4 * half[0] * half[0] + 4 * half[1] * half[1])) / 12
      desc = desc.setMassProperties(mass, { x: 0, y: 0, z: 0 }, { x: i, y: i, z: i }, { x: 0, y: 0, z: 0, w: 1 })
    } else desc = desc.setDensity(1)
    return desc
      .setCollisionGroups((GROUP_ROBOT << 16) | (GROUP_STATIC | GROUP_BALL | GROUP_ROBOT))
      .setFriction(ch.friction ?? (realistic ? 0.45 : 0.5))
      .setRestitution(ch.restitution ?? (realistic ? 0.25 : 0.2))
      .setFrictionCombineRule(realistic ? RAPIER.CoefficientCombineRule.Average : RAPIER.CoefficientCombineRule.Multiply)
      .setRestitutionCombineRule(realistic ? RAPIER.CoefficientCombineRule.Average : RAPIER.CoefficientCombineRule.Multiply)
  }

  private addOthers(): void {
    this.others = []
    for (const spec of this.robotSpec.others ?? []) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().enabledTranslations(true, true, false).enabledRotations(false, false, true).setCanSleep(false)
          .setTranslation(spec.start.x, spec.start.y, spec.half[2]).setRotation(yawQuat(spec.start.yaw)),
      )
      const collider = this.world.createCollider(this.bumperCollider(spec.half, spec.mass, undefined, true), body)
      this.others.push({ spec, body, collider, inertia: (spec.mass * (4 * spec.half[0] ** 2 + 4 * spec.half[1] ** 2)) / 12, ctrl: spec.ai ? new BotController(spec.ai) : null })
    }
  }

  /** What a bot controller needs from the world. */
  private botHost(): BotHost {
    return {
      time: this.time,
      pieceNear: (x, y, r) => {
        let best: number | null = null
        let bestD = r
        for (const p of this.pieces) {
          const t = this.world.getRigidBody(p.handle).translation()
          if (t.z > 0.3) continue // only FUEL on the floor
          const d = Math.hypot(t.x - x, t.y - y)
          if (d < bestD) { bestD = d; best = p.id }
        }
        return best
      },
      removePiece: (id) => this.removePiece(id),
      spawn: (s) => this.spawn(s),
      rand: this.rng.fn(),
      pieceSpec: this.robotSpec.balls?.piece ?? this.pieceSpecs[0].id,
    }
  }

  // ---------------------------------------------------------------- terrain

  /** The floor under a robot: height at the body origin, the plane through the heights at the contact points (pitch, roll) and its slope in the field. */
  private tiltAt(x: number, y: number, yaw: number, points: [number, number][]): Tilt {
    const terrain = this.game.terrain
    if (!terrain) return FLAT
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    const n = points.length
    const hs: number[] = []
    let mx = 0, my = 0, mh = 0
    for (const [px, py] of points) {
      const h = terrain(x + c * px - sn * py, y + sn * px + c * py)
      hs.push(h); mx += px; my += py; mh += h
    }
    mx /= n; my /= n; mh /= n
    let sxx = 0, sxy = 0, syy = 0, sxh = 0, syh = 0
    points.forEach(([px, py], i) => {
      const dx = px - mx, dy = py - my, dh = hs[i] - mh
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxh += dx * dh; syh += dy * dh
    })
    const det = sxx * syy - sxy * sxy
    if (det < 1e-9) return { ...FLAT, z: mh }
    const gx = (sxh * syy - syh * sxy) / det // slope along the robot's forward axis
    const gy = (syh * sxx - sxh * sxy) / det // slope along its left axis
    return { z: mh - gx * mx - gy * my, pitch: -Math.atan(gx), roll: Math.atan(gy), gx: c * gx - sn * gy, gy: sn * gx + c * gy }
  }

  private robotPoints(): [number, number][] {
    const m = this.drivetrain?.spec.modules
    if (m && m.length >= 3) return m.map((q) => [q.x, q.y])
    const [hx, hy] = this.robotSpec.half
    return [[hx, hy], [hx, -hy], [-hx, hy], [-hx, -hy]]
  }

  // ---------------------------------------------------------------- pieces

  /** What the ball model needs from the engine. */
  private ballHost(): BallHost {
    return {
      dt: this.dt,
      robotPose: () => {
        const t = this.robot.translation()
        const q = this.robot.rotation()
        const v = this.robot.linvel()
        return { x: t.x, y: t.y, yaw: 2 * Math.atan2(q.z, q.w), vx: v.x, vy: v.y }
      },
      mechanism: (name) => this.mechanismByName.get(name),
      piecesInBox: (center, yaw, half, cb) => {
        const key = half.join(',')
        let shape = this.captureShapes.get(key)
        if (!shape) { shape = new RAPIER.Cuboid(half[0], half[1], half[2]); this.captureShapes.set(key, shape) }
        this.world.intersectionsWithShape({ x: center[0], y: center[1], z: center[2] }, yawQuat(yaw), shape, (collider) => {
          const handle = collider.parent()?.handle
          const p = handle === undefined ? undefined : this.pieceByHandle.get(handle)
          if (p) {
            const b = this.world.getRigidBody(p.handle)
            const t = b.translation()
            const v = b.linvel()
            cb(p.id, p.spec.id, [t.x, t.y, t.z], [v.x, v.y, v.z])
          }
          return true
        })
      },
      pieceRadius: (spec) => this.pieceSpecs[this.specByName.get(spec)!].radius,
      removePiece: (id) => this.removePiece(id),
      spawn: (s) => this.spawn(s),
      emit: (e) => this.emit(e),
    }
  }

  /** Adds a piece to the world and returns its id. */
  spawn(s: PieceSpawn): number {
    const idx = this.specByName.get(s.spec)
    if (idx === undefined) throw new Error(`Unknown piece spec "${s.spec}"`)
    const spec = this.pieceSpecs[idx]
    const volume = (4 / 3) * Math.PI * spec.radius ** 3
    const v = s.velocity ?? [0, 0, 0]
    const w = s.angularVelocity ?? [0, 0, 0]
    // with the pile manager a piece that starts at rest starts frozen (a fixed body), so a big layout costs nothing until it is touched
    const frozen = this.pile !== null && (s.asleep ?? false)
    const body = this.world.createRigidBody(
      (frozen ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
        .setTranslation(s.position[0], s.position[1], s.position[2])
        .setLinvel(v[0], v[1], v[2])
        .setAngvel({ x: w[0], y: w[1], z: w[2] })
        .setAngularDamping(spec.rollingDamping)
        .setSleeping(s.asleep ?? false)
        .setCcdEnabled(this.tuning.ccd === undefined || this.tuning.ccd === 'all' || this.tuning.ccd === 'fast')
        .setSoftCcdPrediction(this.tuning.ccd === 'soft' ? this.tuning.softCcd ?? 0.05 : 0),
    )
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(spec.radius)
        .setCollisionGroups((GROUP_BALL << 16) | 0xffff)
        .setDensity(spec.mass / volume)
        .setFriction(spec.friction)
        .setRestitution(spec.restitution)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
      body,
    )
    const id = this.nextPieceId++
    const piece: Piece = { id, spec, specIndex: idx, handle: body.handle, x: s.position[0], y: s.position[1], z: s.position[2] }
    this.pieces.push(piece)
    this.pieceByHandle.set(body.handle, piece)
    this.pieceById.set(id, piece)
    if (frozen) this.pile!.addFrozen(id, s.position[0], s.position[1])
    return id
  }

  removePiece(id: number): void {
    const i = this.pieces.findIndex((p) => p.id === id)
    if (i < 0) return
    const body = this.world.getRigidBody(this.pieces[i].handle)
    if (body) this.world.removeRigidBody(body)
    this.pieceByHandle.delete(this.pieces[i].handle)
    this.pieceById.delete(id)
    this.pile?.remove(id)
    this.pieces.splice(i, 1)
    for (const set of this.sensorInside.values()) set.delete(id)
  }

  /** Position, velocity and spin of a piece, or null if it is gone. */
  pieceState(id: number): { position: Vec3; velocity: Vec3; angularVelocity: Vec3; sleeping: boolean } | null {
    const p = this.pieces.find((q) => q.id === id)
    if (!p) return null
    const b = this.world.getRigidBody(p.handle)
    const t = b.translation()
    const v = b.linvel()
    const w = b.angvel()
    return { position: [t.x, t.y, t.z], velocity: [v.x, v.y, v.z], angularVelocity: [w.x, w.y, w.z], sleeping: b.isSleeping() }
  }

  get pieceIds(): number[] { return this.pieces.map((p) => p.id) }

  // ---------------------------------------------------------------- stepping

  /** Sets the applied voltage of a Talon by CAN id: the drivetrain's motors or a mechanism, whichever has it. */
  setMotorVolts(id: number, volts: number): void {
    this.drivetrain?.setVolts(id, volts)
    if (this.mechanisms.has(id)) this.mechanismVolts.set(id, volts)
  }

  /** The robot code zeroed this motor's position: zero the mechanism's physics state too. */
  resetMechanism(id: number): void { this.mechanisms.get(id)?.reset() }

  /** Rotor states of every simulated motor: swerve drive and steer motors and the mechanisms. */
  motorStates(): MotorState[] {
    return [...(this.drivetrain?.motorStates() ?? []), ...[...this.mechanisms.values()].map((m) => m.motorState())]
  }

  /**
   * Like motorStates(), but the mechanisms are shown `lead` seconds ahead, assuming their voltages stay as they are. The robot
   * applies this answer about one round trip after the frame it answers, so reporting where the mechanism will be by then
   * takes the exchange delay out of the Talons' control loops (a real robot has about 1 ms of CAN latency, the bridge several).
   * Only the mechanisms are projected; the drivetrain needs the world stepped and is reported as it is.
   */
  predictMotorStates(lead: number): MotorState[] {
    const out = this.drivetrain?.motorStates() ?? []
    const n = Math.round(lead / this.dt)
    for (const [id, m] of this.mechanisms) {
      const saved = m.save()
      const volts = this.mechanismVolts.get(id) ?? 0
      for (let i = 0; i < n; i++) m.step(this.dt, volts)
      out.push(m.motorState())
      m.load(saved)
    }
    return out
  }

  step(): void {
    for (const [id, m] of this.mechanisms) m.step(this.dt, this.mechanismVolts.get(id) ?? 0)
    const v0 = this.robot.linvel()
    if (this.drivetrain) this.driveFromMotors()
    else this.driveRobot()
    this.driveOthers()
    this.applyAirDrag()
    this.world.step()
    this.stepCount++
    this.senseChassis(v0)
    this.pile?.step()
    this.checkSensors()
    this.ballSystem?.step()
    this.flushRemovals()
    this.updatePhase()
    this.tickGame()
  }

  /** Steps for the given simulated duration (rounded to whole steps). */
  run(seconds: number): void {
    const n = Math.round(seconds / this.dt)
    for (let i = 0; i < n; i++) this.step()
  }

  /** Swerve model: tire forces from the applied motor voltages act on the chassis body. */
  private driveFromMotors(): void {
    const t = this.robot.translation()
    const q = this.robot.rotation()
    const v = this.robot.linvel()
    const w = this.robot.angvel()
    const yaw = 2 * Math.atan2(q.z, q.w)
    const load = this.drivetrain!.step(this.dt, { x: t.x, y: t.y, yaw, vx: v.x, vy: v.y, omega: w.z })
    // the floor's slope pushes the chassis back down a ramp (the body is planar; the height it gains is the energy a climb costs)
    const tilt = this.tiltAt(t.x, t.y, yaw, this.robotPoints())
    const fx = load.fx - this.robotMass * GRAVITY * tilt.gx
    const fy = load.fy - this.robotMass * GRAVITY * tilt.gy
    this.driveForce = { fx, fy }
    this.robot.resetForces(true)
    this.robot.addForce({ x: fx, y: fy, z: 0 }, true)
    this.robot.resetTorques(true)
    this.robot.addTorque({ x: 0, y: 0, z: load.torque }, true)
  }

  /**
   * Other robots: each step cancels the error between the body's velocity and its script (zero when it has none), with the force and
   * torque limited by traction (mu times weight). So it brakes like Coulomb friction (holds against a push up to that force, slides
   * above it) and accelerates at the traction limit. The slope pushes on it too.
   */
  private driveOthers(): void {
    for (const o of this.others) {
      const sp = o.spec
      const b = o.body
      let vx = 0, vy = 0, omega = 0
      const q = b.rotation()
      const yaw = 2 * Math.atan2(q.z, q.w)
      if (o.ctrl) {
        const p = b.translation()
        const cmd = o.ctrl.command({ x: p.x, y: p.y, yaw }, this.botHost())
        vx = cmd.vx; vy = cmd.vy; omega = cmd.omega
      } else {
        let acc = 0
        for (const seg of sp.script ?? []) {
          if (this.time < acc + seg.duration) { vx = seg.vx; vy = seg.vy; omega = seg.omega; break }
          acc += seg.duration
        }
      }
      const c = Math.cos(yaw), sn = Math.sin(yaw)
      const v = b.linvel()
      const w = b.angvel().z
      const fmax = (sp.mu ?? 1) * sp.mass * GRAVITY
      let fx = (sp.mass * (vx * c - vy * sn - v.x)) / this.dt
      let fy = (sp.mass * (vx * sn + vy * c - v.y)) / this.dt
      const mag = Math.hypot(fx, fy)
      if (mag > fmax) { fx *= fmax / mag; fy *= fmax / mag }
      const tmax = fmax * 0.4 * Math.hypot(sp.half[0], sp.half[1])
      const torque = Math.max(-tmax, Math.min(tmax, (o.inertia * (omega - w)) / this.dt))
      const t = b.translation()
      const tilt = this.tiltAt(t.x, t.y, yaw, [[sp.half[0], sp.half[1]], [sp.half[0], -sp.half[1]], [-sp.half[0], sp.half[1]], [-sp.half[0], -sp.half[1]]])
      b.resetForces(true)
      b.addForce({ x: fx - sp.mass * GRAVITY * tilt.gx, y: fy - sp.mass * GRAVITY * tilt.gy, z: 0 }, true)
      b.resetTorques(true)
      b.addTorque({ x: 0, y: 0, z: torque }, true)
    }
  }

  /**
   * What the chassis felt this step: its acceleration and the floor tilt go to the Pigeon, and the part of the acceleration the drive
   * and the slope did not cause is a contact. A contact is one impact event when it ends (quiet for 50 ms) with the speed it changed.
   */
  private senseChassis(v0: { x: number; y: number; z: number }): void {
    if (!this.drivetrain) return
    const v1 = this.robot.linvel()
    const ax = (v1.x - v0.x) / this.dt
    const ay = (v1.y - v0.y) / this.dt
    const t = this.robot.translation()
    const q = this.robot.rotation()
    const tilt = this.tiltAt(t.x, t.y, 2 * Math.atan2(q.z, q.w), this.robotPoints())
    this.drivetrain.setInertial(ax, ay, tilt.pitch, tilt.roll, this.dt)

    const cx = ax - this.driveForce.fx / this.robotMass
    const cy = ay - this.driveForce.fy / this.robotMass
    const k = this.contact
    if (Math.hypot(cx, cy) > IMPACT_ACCEL) {
      k.vx += cx * this.dt; k.vy += cy * this.dt; k.acc += this.dt; k.quiet = 0
      if (this.others.length > 0 && k.against === 'field') {
        for (const o of this.others) this.world.contactPair(this.robotCollider, o.collider, (m) => { if (m.numContacts() > 0) k.against = 'robot' })
      }
    } else if (k.acc > 0 && ++k.quiet >= IMPACT_QUIET_STEPS) {
      const speed = Math.hypot(k.vx, k.vy)
      if (speed >= IMPACT_MIN_SPEED) {
        k.count++
        k.peak = Math.max(k.peak, speed)
        this.emit({ type: 'robot-impact', against: k.against, speed })
      }
      k.acc = 0; k.quiet = 0; k.vx = 0; k.vy = 0; k.against = 'field'
    }
  }

  private driveRobot(): void {
    const t = this.time
    let acc = 0
    let vx = 0
    let vy = 0
    let omega = 0
    for (const s of this.robotSpec.script) {
      if (t < acc + s.duration) { vx = s.vx; vy = s.vy; omega = s.omega; break }
      acc += s.duration
    }
    const q = this.robot.rotation()
    const yaw = 2 * Math.atan2(q.z, q.w)
    const c = Math.cos(yaw)
    const sn = Math.sin(yaw)
    this.robot.setLinvel({ x: vx * c - vy * sn, y: vx * sn + vy * c, z: 0 }, true)
    this.robot.setAngvel({ x: 0, y: 0, z: omega }, true)
  }

  /** Per-step piece forces and material: quadratic air drag, Magnus lift from spin, and speed-dependent foam restitution. */
  /** Visits the pieces that are awake: a resting piece needs no per-step work, and Rapier lists the active bodies directly. */
  private forEachActivePiece(cb: (p: Piece, b: RigidBody) => void): void {
    this.world.forEachActiveRigidBody((b) => {
      const p = this.pieceByHandle.get(b.handle)
      if (p) cb(p, b)
    })
  }

  /** What the pile manager needs from the world. */
  private pileHost(): PileHost {
    return {
      dt: this.dt,
      forEachActive: (cb) => this.forEachActivePiece((p, b) => cb(p.id, b)),
      position: (id) => { const p = this.pieceById.get(id); return p ? [p.x, p.y] : null },
      freeze: (id) => {
        const p = this.pieceById.get(id)
        if (!p) return
        const b = this.world.getRigidBody(p.handle)
        const t = b.translation()
        p.x = t.x; p.y = t.y; p.z = t.z
        b.setLinvel({ x: 0, y: 0, z: 0 }, false)
        b.setAngvel({ x: 0, y: 0, z: 0 }, false)
        b.setBodyType(RAPIER.RigidBodyType.Fixed, false)
      },
      thaw: (id) => {
        const p = this.pieceById.get(id)
        if (p) this.world.getRigidBody(p.handle).setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      },
      robot: () => { const t = this.robot.translation(); const v = this.robot.linvel(); return { x: t.x, y: t.y, speed: Math.hypot(v.x, v.y) } },
    }
  }

  private applyTuning(): void {
    const ip = this.world.integrationParameters
    const t = this.tuning
    if (this.solverIterations) ip.numSolverIterations = this.solverIterations
    if (t.pgsIterations !== undefined) ip.numInternalPgsIterations = t.pgsIterations
    if (t.maxCcdSubsteps !== undefined) ip.maxCcdSubsteps = t.maxCcdSubsteps
    if (t.contactFrequency !== undefined) ip.contact_natural_frequency = t.contactFrequency
    if (t.allowedError !== undefined) ip.normalizedAllowedLinearError = t.allowedError
    if (t.predictionDistance !== undefined) ip.normalizedPredictionDistance = t.predictionDistance
  }

  private applyAirDrag(): void {
    const fastCcd = this.tuning.ccd === 'fast'
    const fastSpeed = this.tuning.fastSpeed ?? 3
    this.forEachActivePiece((p, b) => {
      const sp = p.spec
      if (fastCcd) { const lv = b.linvel(); b.enableCcd(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > fastSpeed * fastSpeed) }
      if (sp.dragCoefficient === 0 && !sp.magnus && !sp.restitutionCurve) return
      const v = b.linvel()
      const speed = Math.hypot(v.x, v.y, v.z)
      if (sp.restitutionCurve) b.collider(0).setRestitution(sp.restitution * interp(sp.restitutionCurve, speed))
      b.resetForces(false)
      if (speed < 1e-9) return
      const area = Math.PI * sp.radius ** 2
      let fx = 0
      let fy = 0
      let fz = 0
      if (sp.dragCoefficient !== 0) {
        const k = -0.5 * AIR_DENSITY * sp.dragCoefficient * area * speed
        fx = k * v.x; fy = k * v.y; fz = k * v.z
      }
      if (sp.magnus) {
        const w = b.angvel()
        // lift along w x v, with C_L = min(max, gain * r * |w| / v)
        const cx = w.y * v.z - w.z * v.y
        const cy = w.z * v.x - w.x * v.z
        const cz = w.x * v.y - w.y * v.x
        const cm = Math.hypot(cx, cy, cz)
        if (cm > 1e-12) {
          const spin = (sp.radius * Math.hypot(w.x, w.y, w.z)) / speed
          const cl = Math.min(sp.magnus.max, sp.magnus.gain * spin)
          const k = (0.5 * AIR_DENSITY * cl * area * speed * speed) / cm
          fx += k * cx; fy += k * cy; fz += k * cz
        }
      }
      b.addForce({ x: fx, y: fy, z: fz }, false)
    })
  }

  private checkSensors(): void {
    const sensors = this.game.field().sensors
    if (sensors.length === 0) return
    const events: GameEvent[] = []
    this.forEachActivePiece((p, b) => {
      const t = b.translation()
      for (const s of sensors) {
        const set = this.sensorInside.get(s.id)!
        const inside = insideBox(t, s)
        const was = set.has(p.id)
        if (inside && !was) {
          set.add(p.id)
          events.push({ type: 'piece-entered-sensor', sensor: s, pieceId: p.id, spec: p.spec.id })
        } else if (!inside && was) {
          set.delete(p.id)
          events.push({ type: 'piece-left-sensor', sensor: s, pieceId: p.id, spec: p.spec.id })
        }
      }
    })
    // events are handled after the walk, so a game module may spawn or remove pieces freely
    for (const e of events) this.emit(e)
  }

  private flushRemovals(): void {
    if (this.removeQueue.length === 0) return
    const q = this.removeQueue
    this.removeQueue = []
    for (const id of q) this.removePiece(id)
  }

  // ---------------------------------------------------------------- match flow and events

  private phaseName(): string {
    const phases = this.game.matchFlow().phases
    return this.phaseIndex < 0 ? 'none' : phases[this.phaseIndex].name
  }

  private updatePhase(): void {
    const phases = this.game.matchFlow().phases
    const t = this.time
    let acc = 0
    let idx = phases.length - 1
    for (let i = 0; i < phases.length; i++) {
      acc += phases[i].duration
      if (t < acc) { idx = i; break }
    }
    if (idx !== this.phaseIndex) {
      const from = this.phaseIndex < 0 ? null : phases[this.phaseIndex].name
      this.phaseIndex = idx
      this.emit({ type: 'phase-changed', from, to: phases[idx].name })
    }
  }

  private gameContext(): GameContext {
    const t = this.robot.translation()
    const q = this.robot.rotation()
    return {
      time: this.time,
      phase: this.phaseName(),
      rng: this.rng.fn(),
      state: this.gameState,
      removePiece: (id) => { this.removeQueue.push(id) },
      spawn: (s) => this.spawn(s),
      robot: { x: t.x, y: t.y, yaw: 2 * Math.atan2(q.z, q.w), half: [this.robotSpec.half[0], this.robotSpec.half[1]], alliance: this.robotSpec.alliance ?? 'blue' },
    }
  }

  private tickGame(): void {
    if (this.game.onTick) this.applyScores(this.game.onTick(this.gameContext()))
  }

  private emit(e: GameEvent): void {
    for (const o of this.observers) o(e, this.time)
    this.applyScores(this.game.onEvent(e, this.gameContext()))
  }

  /** Watches every game event (captures, launches, sensor entries, impacts, phase changes) without taking part: for analytics and logs. Returns a function that removes it. */
  observe(fn: (e: GameEvent, time: number) => void): () => void {
    this.observers.push(fn)
    return () => { this.observers = this.observers.filter((o) => o !== fn) }
  }
  private observers: ((e: GameEvent, time: number) => void)[] = []

  /** Watches every score entry (points, who, why) as it is added. Returns a function that removes it. */
  observeScores(fn: (s: ScoreEntry) => void): () => void {
    this.scoreObservers.push(fn)
    return () => { this.scoreObservers = this.scoreObservers.filter((o) => o !== fn) }
  }
  private scoreObservers: ((s: ScoreEntry) => void)[] = []

  private applyScores(scores: Score[]): void {
    for (const s of scores) {
      this.scores[s.alliance] += s.points
      const entry = { ...s, time: this.time }
      this.scoreLog.push(entry)
      if (this.scoreLog.length > SCORE_LOG_CAP) this.scoreLog.shift()
      for (const o of this.scoreObservers) o(entry)
    }
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(): EngineSnapshot {
    const sensorInside: Record<string, number[]> = {}
    for (const [id, set] of this.sensorInside) sensorInside[id] = [...set]
    return {
      version: 1,
      world: this.world.takeSnapshot(),
      time: this.time,
      stepCount: this.stepCount,
      rng: this.rng.state,
      nextPieceId: this.nextPieceId,
      pieces: this.pieces.map((p) => ({ id: p.id, spec: p.spec.id, handle: p.handle })),
      robotHandle: this.robot.handle,
      sensorInside,
      scores: { ...this.scores },
      scoreLog: this.scoreLog.map((s) => ({ ...s })),
      phaseIndex: this.phaseIndex,
      gameState: JSON.parse(JSON.stringify(this.gameState)),
      drivetrain: this.drivetrain?.save(),
      balls: this.ballSystem?.save(),
      otherHandles: this.others.map((o) => o.body.handle),
      pile: this.pile ? { rest: [...this.pile.rest.entries()] } : undefined,
      botStates: this.others.map((o) => o.ctrl?.save() ?? null),
      contact: { ...this.contact },
      mechanisms: Object.fromEntries([...this.mechanisms].map(([id, m]) => [id, m.save()])),
    }
  }

  restore(s: EngineSnapshot): void {
    this.world.free()
    this.world = RAPIER.World.restoreSnapshot(s.world)
    this.world.timestep = this.dt
    this.applyTuning()
    this.stepCount = s.stepCount
    this.rng.state = s.rng
    this.nextPieceId = s.nextPieceId
    this.pieces = s.pieces.map((p) => {
      const idx = this.specByName.get(p.spec)!
      const t = this.world.getRigidBody(p.handle).translation()
      return { id: p.id, spec: this.pieceSpecs[idx], specIndex: idx, handle: p.handle, x: t.x, y: t.y, z: t.z }
    })
    this.pieceByHandle = new Map(this.pieces.map((p) => [p.handle, p]))
    this.pieceById = new Map(this.pieces.map((p) => [p.id, p]))
    if (this.tuning.pile) {
      this.pile = new PileManager(this.pileHost(), this.tuning.pile === true ? {} : this.tuning.pile)
      for (const p of this.pieces) if (this.world.getRigidBody(p.handle).isFixed()) this.pile.addFrozen(p.id, p.x, p.y)
      for (const [id, n] of s.pile?.rest ?? []) this.pile.rest.set(id, n)
    }
    this.robot = this.world.getRigidBody(s.robotHandle)
    this.robotCollider = this.robot.collider(0)
    this.others.forEach((o, i) => {
      o.body = this.world.getRigidBody(s.otherHandles![i])
      o.collider = o.body.collider(0)
    })
    if (s.contact) this.contact = { ...s.contact }
    this.others.forEach((o, i) => { const st = s.botStates?.[i]; if (o.ctrl && st) o.ctrl.load(st as never) })
    this.sensorInside = new Map(Object.entries(s.sensorInside).map(([k, v]) => [k, new Set(v)]))
    this.scores = { ...s.scores }
    this.scoreLog = s.scoreLog.map((e) => ({ ...e }))
    this.phaseIndex = s.phaseIndex
    this.gameState = JSON.parse(JSON.stringify(s.gameState))
    this.removeQueue = []
    if (this.drivetrain && s.drivetrain) this.drivetrain.load(s.drivetrain)
    if (this.ballSystem && s.balls) this.ballSystem.load(s.balls)
    for (const [id, m] of this.mechanisms) if (s.mechanisms?.[id]) m.load(s.mechanisms[id])
  }

  // ---------------------------------------------------------------- observation

  /** A hash of the complete simulation state; equal hashes mean equal states. */
  hash(): string {
    const h = new Hasher()
    h.add(this.stepCount)
    h.add(this.rng.state)
    h.add(this.scores.red); h.add(this.scores.blue); h.add(this.scores.none)
    const addBody = (b: RigidBody): void => {
      const t = b.translation(); const q = b.rotation(); const v = b.linvel(); const w = b.angvel()
      h.add(t.x); h.add(t.y); h.add(t.z)
      h.add(q.x); h.add(q.y); h.add(q.z); h.add(q.w)
      h.add(v.x); h.add(v.y); h.add(v.z)
      h.add(w.x); h.add(w.y); h.add(w.z)
    }
    addBody(this.robot)
    for (const o of this.others) { addBody(o.body); if (o.ctrl) { const st = o.ctrl.state; h.add(st.wp); h.add(st.carried); h.add(st.fired); h.add(st.taken); h.add(st.nextAct) } }
    if (this.pile) h.add(this.pile.frozen.size)
    if (this.contact.count > 0) { h.add(this.contact.count); h.add(this.contact.peak) }
    this.drivetrain?.hashInto((x) => h.add(x))
    for (const m of this.mechanisms.values()) { h.add(m.angle); h.add(m.speed) }
    if (this.ballSystem) { for (const s of this.ballSystem.held) h.add(s); h.add(this.ballSystem.shots); h.add(this.ballSystem.captured) }
    for (const p of this.pieces) { h.add(p.id); addBody(this.world.getRigidBody(p.handle)) }
    return h.digest()
  }

  /**
   * What the renderer needs. Only awake pieces are read from the physics world; a resting piece keeps its last position. The state
   * hash walks every body, so callers that draw at 60 Hz pass withHash = false on most frames and keep the last one.
   */
  getFrame(withHash = true): RenderFrame {
    const n = this.pieces.length
    const pos = new Float32Array(n * 3)
    const spec = new Uint8Array(n)
    let awake = 0
    this.forEachActivePiece((p, b) => {
      const t = b.translation()
      p.x = t.x; p.y = t.y; p.z = t.z
      awake++
    })
    for (let i = 0; i < n; i++) {
      const p = this.pieces[i]
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
      spec[i] = p.specIndex
    }
    const t = this.robot.translation()
    const q = this.robot.rotation()
    const v = this.robot.linvel()
    const yaw = 2 * Math.atan2(q.z, q.w)
    const tilt = this.tiltAt(t.x, t.y, yaw, this.robotPoints())
    const [qw, qx, qy, qz] = tiltQuat(yaw, tilt.pitch, tilt.roll)
    const others = this.others.map((o) => {
      const ot = o.body.translation()
      const oq = o.body.rotation()
      const oyaw = 2 * Math.atan2(oq.z, oq.w)
      const [hx, hy] = o.spec.half
      const ti = this.tiltAt(ot.x, ot.y, oyaw, [[hx, hy], [hx, -hy], [-hx, hy], [-hx, -hy]])
      const [w, x, y, z] = tiltQuat(oyaw, ti.pitch, ti.roll)
      return [ot.x, ot.y, ot.z + ti.z, w, x, y, z]
    })
    return {
      time: this.time,
      phase: this.phaseName(),
      scores: { ...this.scores },
      robot: [t.x, t.y, t.z + tilt.z, qw, qx, qy, qz],
      robotSpeed: Math.hypot(v.x, v.y),
      others,
      impacts: { count: this.contact.count, peak: this.contact.peak },
      pieceCount: n,
      awakeCount: awake,
      piecePositions: pos,
      pieceSpecIndex: spec,
      status: this.game.status ? this.game.status(this.gameState, this.time) : {},
      hash: withHash ? (this.lastHash = this.hash()) : this.lastHash,
      held: this.ballSystem ? [...this.ballSystem.held] : [],
      beams: this.ballSystem ? [...this.ballSystem.beams] : [],
      capture: this.ballSystem ? this.ballSystem.captureBox() : null,
      shots: this.ballSystem?.shots ?? 0,
      captured: this.ballSystem?.captured ?? 0,
    }
  }
}
