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
  eachPiece(cb: (id: number, spec: string, position: Vec3, velocity: Vec3) => void): void
  pieceRadius(spec: string): number
  removePiece(id: number): void
  spawn(s: PieceSpawn): number
  emit(e: GameEvent): void
}

export interface BallSnapshot { held: number[]; shots: number; captured: number }

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

  constructor(private spec: BallHandlingSpec, private host: BallHost) {
    let acc = 0
    for (const s of spec.stages) { this.stageStart.push(acc); acc += s.length }
    this.pathLength = acc
    this.radius = host.pieceRadius(spec.piece)
    this.spacing = 2 * this.radius
    this.beams = spec.beams.map(() => false)
  }

  reset(): void { this.held = []; this.shots = 0; this.captured = 0; this.beams = this.spec.beams.map(() => false) }

  save(): BallSnapshot { return { held: [...this.held], shots: this.shots, captured: this.captured } }

  load(s: BallSnapshot): void { this.held = [...s.held]; this.shots = s.shots; this.captured = s.captured; this.updateBeams() }

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
    // there must be room at the mouth
    if (this.held.length > 0 && this.held[0] < this.spacing - 1e-9) return
    const p = this.host.robotPose()
    const cy = Math.cos(-box.yaw)
    const sy = Math.sin(-box.yaw)
    let hit: number | null = null
    let hitSpec = ''
    this.host.eachPiece((id, spec, pos, vel) => {
      if (hit !== null || spec !== this.spec.piece) return
      const dx = pos[0] - box.center[0]
      const dy = pos[1] - box.center[1]
      const lx = dx * cy - dy * sy
      const ly = dx * sy + dy * cy
      if (Math.abs(lx) > box.half[0] || Math.abs(ly) > box.half[1] || Math.abs(pos[2] - box.center[2]) > box.half[2]) return
      if (Math.hypot(vel[0] - p.vx, vel[1] - p.vy) > this.spec.intake.maxRelativeSpeed) return
      hit = id
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
    const st = this.spec.stages[idx]
    const m = this.host.mechanism(st.driver)
    return m ? st.direction * m.rps * TWO_PI * st.radius : 0
  }

  private moveStages(): void {
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
    this.beams = this.spec.beams.map((b) => this.held.some((s) => Math.abs(s - b.position) < this.radius))
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
    this.host.spawn({ spec: this.spec.piece, position, velocity, angularVelocity })
    this.held.pop()
    this.shots++
    this.host.emit({ type: 'piece-launched', spec: this.spec.piece, speed })
  }

  get captureIsActive(): boolean { return this.captureActive }
}
