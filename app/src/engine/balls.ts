// The hybrid ball model: pieces outside the robot are rigid bodies in the world; inside the robot they are only entries in a
// virtual queue. The intake capture volume turns a body into a queue entry, the stages carry entries toward the shooter at the
// speed of their driving rollers, beam breaks report where entries are, and the shooter turns the front entry back into a
// rigid body launched from the flywheel and hood state. Everything is driven by the mechanism states the robot code produced.
import type { MechanismModel } from './mechanism'
import type { BallHandlingSpec, GameEvent, PieceSpawn, Vec3 } from './types'

const TWO_PI = 2 * Math.PI

export interface BallHost {
  readonly dt: number
  robotPose(): { x: number; y: number; yaw: number; vx: number; vy: number }
  mechanism(name: string): MechanismModel | undefined
  /** Calls cb for every piece whose collider overlaps the oriented box (found with the broadphase, asleep or not). */
  piecesInBox(center: Vec3, yaw: number, half: Vec3, cb: (id: number, spec: string, position: Vec3, velocity: Vec3) => void): void
  pieceRadius(spec: string): number
  pieceMass(spec: string): number
  removePiece(id: number): void
  spawn(s: PieceSpawn): number
  emit(e: GameEvent): void
}

export interface BallSnapshot { held: number[]; shots: number; captured: number; /** pieces in the hopper (absent in older snapshots) */ stored?: number }

/** a stage must carry a piece at least this fast (m/s) to push it into the hopper or out of it */
const HOPPER_MIN_SPEED = 0.05

function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)) }

export class BallSystem {
  /** position of each held piece along the stage path, m from the intake mouth, ascending (the front piece is last) */
  held: number[] = []
  beams: boolean[]
  shots = 0
  captured = 0
  private pathLength: number
  private stageStart: number[] = []
  private radius: number
  /** minimum distance between held pieces' centers */
  private spacing: number
  private captureActive = false
  /** pieces in the hopper stage (if the robot has one): counted, not positioned */
  stored = 0
  private hopperIdx = -1
  private hopperStart = 0
  private hopperEnd = 0
  private capacity: number

  /** Changes the shooter's efficiency and backspin while it runs (the next shot uses them). */
  tuneShooter(efficiency?: number, backspin?: number): void {
    if (efficiency !== undefined) this.spec.shooter.efficiency = efficiency
    if (backspin !== undefined) this.spec.shooter.backspin = backspin
  }

  constructor(private spec: BallHandlingSpec, private host: BallHost) {
    let acc = 0
    for (const s of spec.stages) { this.stageStart.push(acc); acc += s.length }
    this.pathLength = acc
    this.radius = host.pieceRadius(spec.piece)
    this.spacing = 2 * this.radius
    this.beams = spec.beams.map(() => false)
    this.hopperIdx = spec.stages.findIndex((s) => s.hopper === true)
    if (this.hopperIdx >= 0) { this.hopperStart = this.stageStart[this.hopperIdx]; this.hopperEnd = this.hopperStart + spec.stages[this.hopperIdx].length }
    this.capacity = spec.capacity ?? Infinity
  }

  reset(): void {
    // the preload waits at the end of the path, as pieces loaded by hand before the match
    const n = Math.min(this.spec.preload ?? 0, this.capacity)
    this.stored = 0
    if (this.hopperIdx < 0) this.held = Array.from({ length: n }, (_, i) => this.pathLength - (n - 1 - i) * this.spacing)
    else {
      // what fits between the hopper and the exit waits at the exit, the rest of the preload lies in the hopper
      const fit = Math.floor((this.pathLength - this.hopperEnd) / this.spacing + 1e-9) + 1
      const inFront = Math.min(n, fit)
      this.held = Array.from({ length: inFront }, (_, i) => this.pathLength - (inFront - 1 - i) * this.spacing)
      this.stored = n - inFront
    }
    this.shots = 0
    this.captured = 0
    this.updateBeams()
  }

  save(): BallSnapshot { return { held: [...this.held], shots: this.shots, captured: this.captured, stored: this.stored } }

  load(s: BallSnapshot): void { this.held = [...s.held]; this.shots = s.shots; this.captured = s.captured; this.stored = s.stored ?? 0; this.updateBeams() }

  /** Everything the robot holds: the queue and the hopper. */
  get count(): number { return this.held.length + this.stored }

  /** Positions of everything held, ascending, for the frame: the hopper's pieces are given the middle of the hopper stage. */
  heldPositions(): number[] {
    if (this.hopperIdx < 0) return [...this.held]
    const mid = (this.hopperStart + this.hopperEnd) / 2
    return [...this.held.filter((s) => s <= this.hopperStart + 1e-9), ...Array.from({ length: this.stored }, () => mid), ...this.held.filter((s) => s >= this.hopperEnd - 1e-9)]
  }

  step(): void {
    this.moveStages()
    this.capture()
    this.launch()
    this.updateBeams()
  }

  // ---------------------------------------------------------------- intake

  /** Intake extension in metres along the slide, from the driver mechanism's position. */
  private extension(): number {
    const d = this.host.mechanism(this.spec.intake.driver)
    return d ? clamp(d.rotations * this.spec.intake.metersPerRotation, 0, this.spec.intake.travel) : 0
  }

  /** The capture box in the world for the current intake extension: its centre, yaw and half extents. */
  captureBox(): { center: Vec3; yaw: number; half: Vec3; active: boolean } {
    const k = this.spec.intake
    const e = this.extension()
    const back = k.travel - e
    const c: Vec3 = [k.openBox.center[0] - k.slideAxis[0] * back, k.openBox.center[1] - k.slideAxis[1] * back, k.openBox.center[2] - k.slideAxis[2] * back]
    const p = this.host.robotPose()
    const cy = Math.cos(p.yaw)
    const sy = Math.sin(p.yaw)
    const roller = this.host.mechanism(k.roller)
    const rolling = roller !== undefined && roller.rps * k.rollerDirection >= k.minRollerRps
    return {
      center: [p.x + cy * c[0] - sy * c[1], p.y + sy * c[0] + cy * c[1], c[2]],
      yaw: p.yaw,
      half: k.openBox.half,
      active: e >= k.minExtension * k.travel && rolling,
    }
  }

  private capture(): void {
    const box = this.captureBox()
    this.captureActive = box.active
    if (!box.active) return
    if (this.count >= this.capacity) return // full
    // there must be room at the mouth
    if (this.held.length > 0 && this.held[0] < this.spacing - 1e-9) return
    const p = this.host.robotPose()
    const cy = Math.cos(-box.yaw)
    const sy = Math.sin(-box.yaw)
    let hit: number | null = null
    let hitSpec = ''
    this.host.piecesInBox(box.center, box.yaw, [box.half[0] + 0.08, box.half[1] + 0.08, box.half[2] + 0.08], (id, spec, pos, vel) => {
      if (spec !== this.spec.piece || (hit !== null && id > hit)) return
      const dx = pos[0] - box.center[0]
      const dy = pos[1] - box.center[1]
      const lx = dx * cy - dy * sy
      const ly = dx * sy + dy * cy
      if (Math.abs(lx) > box.half[0] || Math.abs(ly) > box.half[1] || Math.abs(pos[2] - box.center[2]) > box.half[2]) return
      if (Math.hypot(vel[0] - p.vx, vel[1] - p.vy) > this.spec.intake.maxRelativeSpeed) return
      hit = id // the lowest id wins, so the choice does not depend on the order of the query
      hitSpec = spec
    })
    if (hit === null) return
    this.host.removePiece(hit)
    this.held.unshift(0)
    this.captured++
    this.host.emit({ type: 'piece-captured', pieceId: hit, spec: hitSpec })
  }

  // ---------------------------------------------------------------- stages

  private surfaceSpeed(s: number): number {
    let idx = 0
    for (let i = 0; i < this.stageStart.length; i++) if (s >= this.stageStart[i]) idx = i
    let v = 0
    for (const d of this.spec.stages[idx].drivers) {
      const m = this.host.mechanism(d.driver)
      if (m) v += d.direction * m.rps * TWO_PI * d.radius
    }
    return v
  }

  /**
   * With a hopper the path is in two parts, each a single file: the intake queue (from the mouth to the hopper's entrance) and the feed queue (from the hopper's
   * exit to the shooter). Between them the hopper stores pieces without positions. The front piece of the intake queue is pushed into the hopper while its stage
   * moves forward; the hopper's own drive puts one piece at a time onto the feed queue when there is room for it.
   */
  private moveWithHopper(): void {
    const dt = this.host.dt
    const hs = this.hopperStart
    const he = this.hopperEnd
    const a = this.held.filter((s) => s <= hs + 1e-9)
    const b = this.held.filter((s) => s >= he - 1e-9)
    const na = a.map((s) => s + this.surfaceSpeed(Math.min(s, hs - 1e-9)) * dt)
    if (na.length > 0) {
      na[na.length - 1] = clamp(na[na.length - 1], 0, hs)
      for (let i = na.length - 2; i >= 0; i--) na[i] = Math.min(na[i], na[i + 1] - this.spacing)
      if (na[0] < 0) na[0] = 0
      for (let i = 1; i < na.length; i++) na[i] = Math.max(na[i], na[i - 1] + this.spacing)
      if (na[na.length - 1] >= hs - 1e-9 && this.surfaceSpeed(hs - 1e-9) > HOPPER_MIN_SPEED) { na.pop(); this.stored++ }
    }
    const nb = b.map((s) => s + this.surfaceSpeed(Math.min(s, this.pathLength - 1e-9)) * dt)
    if (nb.length > 0) {
      nb[nb.length - 1] = clamp(nb[nb.length - 1], he, this.pathLength)
      for (let i = nb.length - 2; i >= 0; i--) nb[i] = Math.min(nb[i], nb[i + 1] - this.spacing)
      if (nb[0] < he) nb[0] = he
      for (let i = 1; i < nb.length; i++) nb[i] = Math.max(nb[i], nb[i - 1] + this.spacing)
    }
    if (this.stored > 0 && this.surfaceSpeed((hs + he) / 2) > HOPPER_MIN_SPEED && (nb.length === 0 || nb[0] >= he + this.spacing - 1e-9)) { nb.unshift(he); this.stored-- }
    this.held = [...na, ...nb]
  }

  private moveStages(): void {
    if (this.hopperIdx >= 0) { this.moveWithHopper(); return }
    const n = this.held.length
    if (n === 0) return
    const dt = this.host.dt
    const next = this.held.map((s) => s + this.surfaceSpeed(Math.min(s, this.pathLength - 1e-9)) * dt)
    // the front piece stops at the end of the path; the others stop behind the one in front
    next[n - 1] = clamp(next[n - 1], 0, this.pathLength)
    for (let i = n - 2; i >= 0; i--) next[i] = Math.min(next[i], next[i + 1] - this.spacing)
    // a piece cannot back out of the mouth; the one behind pushes pieces forward when squeezed
    if (next[0] < 0) next[0] = 0
    for (let i = 1; i < n; i++) next[i] = Math.max(next[i], next[i - 1] + this.spacing)
    this.held = next
  }

  private updateBeams(): void {
    this.beams = this.spec.beams.map((b) => this.held.some((s) => Math.abs(s - b.position) < this.radius) || (this.hopperIdx >= 0 && this.stored > 0 && Math.abs(b.position - this.hopperStart) < 1e-6))
  }

  // ---------------------------------------------------------------- shooter

  private launch(): void {
    const n = this.held.length
    if (n === 0 || this.held[n - 1] < this.pathLength - 1e-6) return
    const sh = this.spec.shooter
    if (this.surfaceSpeed(this.pathLength - 1e-9) < sh.minFeedSpeed) return
    const wheel = this.host.mechanism(sh.flywheel)
    const turret = this.host.mechanism(sh.turret)
    const hood = this.host.mechanism(sh.hood)
    if (!wheel || !turret || !hood) return
    const wheelRps = Math.abs(wheel.rps)
    if (wheelRps < sh.minFlywheelRps) return

    const speed = sh.efficiency * TWO_PI * sh.wheelRadius * wheelRps
    const elev = ((sh.elevationAtHoodZeroDeg - hood.rotations * sh.hoodDegPerRotation) * Math.PI) / 180
    const p = this.host.robotPose()
    const heading = p.yaw + turret.rotations * TWO_PI // turret position 0 points along the robot's forward
    const ch = Math.cos(heading)
    const shd = Math.sin(heading)
    const cp = Math.cos(elev)
    const dir: Vec3 = [cp * ch, cp * shd, Math.sin(elev)]
    const cy = Math.cos(p.yaw)
    const sy = Math.sin(p.yaw)
    const position: Vec3 = [
      p.x + cy * sh.axis[0] - sy * sh.axis[1] + sh.exitForward * ch,
      p.y + sy * sh.axis[0] + cy * sh.axis[1] + sh.exitForward * shd,
      sh.exitHeight,
    ]
    const velocity: Vec3 = [p.vx + speed * dir[0], p.vy + speed * dir[1], speed * dir[2]]
    // backspin: the spin axis is horizontal and perpendicular to the heading, so the Magnus force lifts the ball
    const w = (sh.backspin * speed) / this.radius
    const angularVelocity: Vec3 = [w * shd, -w * ch, 0]
    const pieceId = this.host.spawn({ spec: this.spec.piece, position, velocity, angularVelocity })
    // the piece's kinetic energy comes out of the flywheel: it slows down by a little at every shot and the Talon winds it back up, which is what spaces
    // the shots out (the robot code feeds only while the flywheel is within its tolerance)
    if (sh.energyEfficiency && sh.energyEfficiency > 0) {
      const j = wheel.spec.inertia
      const draw = (0.5 * this.host.pieceMass(this.spec.piece) * speed * speed) / sh.energyEfficiency
      const w = Math.abs(wheel.speed)
      const w2 = Math.sqrt(Math.max(0, w * w - (2 * draw) / j))
      wheel.speed = Math.sign(wheel.speed || 1) * w2
    }
    this.held.pop()
    this.shots++
    this.host.emit({ type: 'piece-launched', spec: this.spec.piece, speed, position, velocity, pieceId })
  }

  get captureIsActive(): boolean { return this.captureActive }
}
