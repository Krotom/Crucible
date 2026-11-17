// The Crucible engine core: a fixed-step Rapier world, the game plug-in host, a scripted robot body, scoring and match
// flow, and bit-for-bit snapshots. No DOM, no wall clock: given the same config and the same number of steps the
// state is identical on every run (deterministic Rapier build, seeded RNG, fixed iteration order).
import RAPIER from '@dimforge/rapier3d-deterministic-compat'
import type { RigidBody, World } from '@dimforge/rapier3d-deterministic-compat'
import { Drivetrain } from './drivetrain'
import { Hasher, Rng } from './rng'
import type {
  Alliance, BoxSpec, EngineConfig, EngineSnapshot, GameContext, GameEvent, GameModule, PieceSpawn, PieceSpec, RenderFrame,
  RobotSpec, Score, ScoreEntry, SensorSpec, Vec3,
} from './types'

const GRAVITY = 9.81
const AIR_DENSITY = 1.225
const SCORE_LOG_CAP = 200

let rapierReady: Promise<void> | null = null
/** Loads the Rapier WASM once per process or worker. */
export function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init()
  return rapierReady
}

interface Piece { id: number; spec: PieceSpec; specIndex: number; handle: number }

function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
}

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

  private world!: World
  private robot!: RigidBody
  private rng: Rng
  private pieces: Piece[] = []
  private nextPieceId = 1
  private stepCount = 0
  private sensorInside = new Map<string, Set<number>>()
  private scores: Record<Alliance, number> = { red: 0, blue: 0, none: 0 }
  private scoreLog: ScoreEntry[] = []
  private phaseIndex = -1
  private gameState: Record<string, unknown> = {}
  private removeQueue: number[] = []
  private scriptEnd = 0
  /** The swerve model when the robot is driven by motor voltages. */
  drivetrain: Drivetrain | null = null

  private constructor(cfg: EngineConfig) {
    this.dt = cfg.dt ?? 0.001
    this.game = cfg.game
    this.robotSpec = cfg.robot
    this.seed = cfg.seed
    this.rng = new Rng(cfg.seed)
    this.pieceSpecs = cfg.game.pieces()
    this.pieceSpecs.forEach((p, i) => this.specByName.set(p.id, i))
    this.drivetrain = cfg.robot.drivetrain ? new Drivetrain(cfg.robot.drivetrain) : null
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
  get scoreTotals(): Record<Alliance, number> { return { ...this.scores } }
  get log(): readonly ScoreEntry[] { return this.scoreLog }
  get pieceCount(): number { return this.pieces.length }
  get scriptDuration(): number { return this.scriptEnd }

  // ---------------------------------------------------------------- building

  /** (Re)creates the world from scratch: field, robot, initial pieces. */
  private build(): void {
    this.world?.free()
    this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY })
    this.world.timestep = this.dt
    this.pieces = []
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
    this.addRobot()
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
    const desc = RAPIER.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
      .setTranslation(b.center[0], b.center[1], b.center[2])
      .setRotation(yawQuat(b.yaw ?? 0))
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
    const desc = driven
      ? RAPIER.RigidBodyDesc.dynamic().enabledTranslations(true, true, false).enabledRotations(false, false, true).setCanSleep(false)
      : RAPIER.RigidBodyDesc.kinematicVelocityBased()
    const body = this.world.createRigidBody(desc.setTranslation(r.start.x, r.start.y, r.half[2]).setRotation(yawQuat(r.start.yaw)))
    const volume = 8 * r.half[0] * r.half[1] * r.half[2]
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(r.half[0], r.half[1], r.half[2])
        .setDensity(driven ? this.drivetrain!.spec.mass / volume : 1)
        .setFriction(driven ? 0.2 : 0.5)
        .setRestitution(0.2)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
      body,
    )
    this.robot = body
  }

  // ---------------------------------------------------------------- pieces

  /** Adds a piece to the world and returns its id. */
  spawn(s: PieceSpawn): number {
    const idx = this.specByName.get(s.spec)
    if (idx === undefined) throw new Error(`Unknown piece spec "${s.spec}"`)
    const spec = this.pieceSpecs[idx]
    const volume = (4 / 3) * Math.PI * spec.radius ** 3
    const v = s.velocity ?? [0, 0, 0]
    const w = s.angularVelocity ?? [0, 0, 0]
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.position[0], s.position[1], s.position[2])
        .setLinvel(v[0], v[1], v[2])
        .setAngvel({ x: w[0], y: w[1], z: w[2] })
        .setAngularDamping(spec.rollingDamping)
        .setCcdEnabled(true),
    )
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(spec.radius)
        .setDensity(spec.mass / volume)
        .setFriction(spec.friction)
        .setRestitution(spec.restitution)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
      body,
    )
    const id = this.nextPieceId++
    this.pieces.push({ id, spec, specIndex: idx, handle: body.handle })
    return id
  }

  removePiece(id: number): void {
    const i = this.pieces.findIndex((p) => p.id === id)
    if (i < 0) return
    const body = this.world.getRigidBody(this.pieces[i].handle)
    if (body) this.world.removeRigidBody(body)
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

  step(): void {
    if (this.drivetrain) this.driveFromMotors()
    else this.driveRobot()
    this.applyAirDrag()
    this.world.step()
    this.stepCount++
    this.checkSensors()
    this.flushRemovals()
    this.updatePhase()
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
    const load = this.drivetrain!.step(this.dt, { x: t.x, y: t.y, yaw: 2 * Math.atan2(q.z, q.w), vx: v.x, vy: v.y, omega: w.z })
    this.robot.resetForces(true)
    this.robot.addForce({ x: load.fx, y: load.fy, z: 0 }, true)
    this.robot.resetTorques(true)
    this.robot.addTorque({ x: 0, y: 0, z: load.torque }, true)
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

  private applyAirDrag(): void {
    for (const p of this.pieces) {
      if (p.spec.dragCoefficient === 0) continue
      const b = this.world.getRigidBody(p.handle)
      if (b.isSleeping()) continue
      const v = b.linvel()
      const speed = Math.hypot(v.x, v.y, v.z)
      b.resetForces(false)
      if (speed < 1e-9) continue
      const k = -0.5 * AIR_DENSITY * p.spec.dragCoefficient * Math.PI * p.spec.radius ** 2 * speed
      b.addForce({ x: k * v.x, y: k * v.y, z: k * v.z }, false)
    }
  }

  private checkSensors(): void {
    const sensors = this.game.field().sensors
    if (sensors.length === 0) return
    for (const p of this.pieces) {
      const b = this.world.getRigidBody(p.handle)
      if (b.isSleeping()) continue
      const t = b.translation()
      for (const s of sensors) {
        const set = this.sensorInside.get(s.id)!
        const inside = insideBox(t, s)
        const was = set.has(p.id)
        if (inside && !was) {
          set.add(p.id)
          this.emit({ type: 'piece-entered-sensor', sensor: s, pieceId: p.id, spec: p.spec.id })
        } else if (!inside && was) {
          set.delete(p.id)
          this.emit({ type: 'piece-left-sensor', sensor: s, pieceId: p.id, spec: p.spec.id })
        }
      }
    }
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

  private emit(e: GameEvent): void {
    const ctx: GameContext = {
      time: this.time,
      phase: this.phaseName(),
      rng: this.rng.fn(),
      state: this.gameState,
      removePiece: (id) => { this.removeQueue.push(id) },
    }
    const scores: Score[] = this.game.onEvent(e, ctx)
    for (const s of scores) {
      this.scores[s.alliance] += s.points
      this.scoreLog.push({ ...s, time: this.time })
      if (this.scoreLog.length > SCORE_LOG_CAP) this.scoreLog.shift()
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
    }
  }

  restore(s: EngineSnapshot): void {
    this.world.free()
    this.world = RAPIER.World.restoreSnapshot(s.world)
    this.world.timestep = this.dt
    this.stepCount = s.stepCount
    this.rng.state = s.rng
    this.nextPieceId = s.nextPieceId
    this.pieces = s.pieces.map((p) => {
      const idx = this.specByName.get(p.spec)!
      return { id: p.id, spec: this.pieceSpecs[idx], specIndex: idx, handle: p.handle }
    })
    this.robot = this.world.getRigidBody(s.robotHandle)
    this.sensorInside = new Map(Object.entries(s.sensorInside).map(([k, v]) => [k, new Set(v)]))
    this.scores = { ...s.scores }
    this.scoreLog = s.scoreLog.map((e) => ({ ...e }))
    this.phaseIndex = s.phaseIndex
    this.gameState = JSON.parse(JSON.stringify(s.gameState))
    this.removeQueue = []
    if (this.drivetrain && s.drivetrain) this.drivetrain.load(s.drivetrain)
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
    this.drivetrain?.hashInto((x) => h.add(x))
    for (const p of this.pieces) { h.add(p.id); addBody(this.world.getRigidBody(p.handle)) }
    return h.digest()
  }

  getFrame(): RenderFrame {
    const n = this.pieces.length
    const pos = new Float32Array(n * 3)
    const spec = new Uint8Array(n)
    let awake = 0
    for (let i = 0; i < n; i++) {
      const b = this.world.getRigidBody(this.pieces[i].handle)
      const t = b.translation()
      pos[i * 3] = t.x; pos[i * 3 + 1] = t.y; pos[i * 3 + 2] = t.z
      spec[i] = this.pieces[i].specIndex
      if (!b.isSleeping()) awake++
    }
    const t = this.robot.translation()
    const q = this.robot.rotation()
    const v = this.robot.linvel()
    return {
      time: this.time,
      phase: this.phaseName(),
      scores: { ...this.scores },
      robot: [t.x, t.y, t.z, q.w, q.x, q.y, q.z],
      robotSpeed: Math.hypot(v.x, v.y),
      pieceCount: n,
      awakeCount: awake,
      piecePositions: pos,
      pieceSpecIndex: spec,
      hash: this.hash(),
    }
  }
}
