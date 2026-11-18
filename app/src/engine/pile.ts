// Deterministic freezing of resting pieces. A pile of hundreds of touching FUEL is one Rapier island, so the moment the robot touches it every
// piece wakes and the solver pays for all of them for seconds. Here a piece that has been at rest for a moment becomes a fixed body (free for the
// solver) and is thawed back to a dynamic body only when something that moves comes near: the robot, or a moving piece. Pieces that are thawed
// push their own neighbors awake in turn, so the work follows the disturbance instead of the whole pile.
//
// Everything is decided from body state in a fixed order (Rapier's active-body order, ids ascending), never from wall time, so runs repeat.
import type { RigidBody } from '@dimforge/rapier3d-deterministic-compat'

export interface PileOptions {
  /** a piece slower than this (m/s) is at rest */
  restSpeed?: number
  /** seconds at rest before a piece is frozen */
  restTime?: number
  /** a moving piece (faster than moveSpeed) thaws frozen pieces within this distance, meters (the touching distance of two FUEL is 0.15) */
  thawRadius?: number
  moveSpeed?: number
  /** frozen pieces within this distance of the robot, plus its speed times a short look-ahead, are thawed */
  robotRadius?: number
}

export interface PileHost {
  readonly dt: number
  forEachActive(cb: (id: number, body: RigidBody) => void): void
  /** x, y of a piece as last read (frozen pieces do not move) */
  position(id: number): [number, number] | null
  freeze(id: number): void
  thaw(id: number): void
  robot(): { x: number; y: number; speed: number }
}

const CELL = 0.3

export class PileManager {
  readonly frozen = new Set<number>()
  /** consecutive steps a piece has been at rest (pieces not listed are 0) */
  readonly rest = new Map<number, number>()
  private cells = new Map<number, number[]>()
  private cellOf = new Map<number, number>()
  private o: Required<PileOptions>

  constructor(private host: PileHost, o: PileOptions = {}) {
    this.o = { restSpeed: o.restSpeed ?? 0.05, restTime: o.restTime ?? 0.4, thawRadius: o.thawRadius ?? 0.36, moveSpeed: o.moveSpeed ?? 0.3, robotRadius: o.robotRadius ?? 1.1 }
  }

  private key(x: number, y: number): number { return Math.floor(x / CELL) * 100_003 + Math.floor(y / CELL) }

  /** Registers a piece that is frozen from the start (spawned at rest) or restored as frozen. */
  addFrozen(id: number, x: number, y: number): void {
    this.frozen.add(id)
    const k = this.key(x, y)
    let c = this.cells.get(k)
    if (!c) { c = []; this.cells.set(k, c) }
    c.push(id)
    this.cellOf.set(id, k)
  }

  private removeFromGrid(id: number): void {
    const k = this.cellOf.get(id)
    if (k === undefined) return
    const c = this.cells.get(k)
    if (c) { const i = c.indexOf(id); if (i >= 0) c.splice(i, 1); if (c.length === 0) this.cells.delete(k) }
    this.cellOf.delete(id)
  }

  /** A piece left the world. */
  remove(id: number): void {
    this.frozen.delete(id)
    this.rest.delete(id)
    this.removeFromGrid(id)
  }

  private thawId(id: number): void {
    if (!this.frozen.has(id)) return
    this.frozen.delete(id)
    this.removeFromGrid(id)
    this.rest.delete(id)
    this.host.thaw(id)
  }

  /** Frozen pieces within r of (x, y), ascending by id. */
  private near(x: number, y: number, r: number): number[] {
    const out: number[] = []
    const ix0 = Math.floor((x - r) / CELL), ix1 = Math.floor((x + r) / CELL)
    const iy0 = Math.floor((y - r) / CELL), iy1 = Math.floor((y + r) / CELL)
    const r2 = r * r
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const c = this.cells.get(ix * 100_003 + iy)
        if (!c) continue
        for (const id of c) {
          const p = this.host.position(id)
          if (p && (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2) out.push(id)
        }
      }
    }
    return out.sort((a, b) => a - b)
  }

  // a step is begin(), observe() for every awake piece, end(); step() does all three with the host's own walk
  private toThaw: number[] = []
  private toFreeze: number[] = []
  private rob = { x: 0, y: 0, speed: 0 }
  private robR = 0
  private restSteps = 0

  begin(): void {
    const o = this.o
    this.toThaw = []
    this.toFreeze = []
    this.rob = this.host.robot()
    this.robR = o.robotRadius + this.rob.speed * 0.15
    this.restSteps = Math.round(o.restTime / this.host.dt)
  }

  /** One awake piece: its position, velocity and body (the spin is read only when the piece is slow enough to maybe freeze). */
  observe(id: number, t: { x: number; y: number }, v: { x: number; y: number; z: number }, b: RigidBody): void {
    const o = this.o
    const s2 = v.x * v.x + v.y * v.y + v.z * v.z
    if (s2 > o.moveSpeed * o.moveSpeed) {
      for (const n of this.near(t.x, t.y, o.thawRadius)) this.toThaw.push(n)
    }
    if (s2 < o.restSpeed * o.restSpeed) {
      const n = (this.rest.get(id) ?? 0) + 1
      this.rest.set(id, n)
      // slow spin (a ball rolling in place) is not rest
      if (n >= this.restSteps && Math.hypot(t.x - this.rob.x, t.y - this.rob.y) > this.robR + 0.1) {
        const w = b.angvel()
        if (w.x * w.x + w.y * w.y + w.z * w.z < 0.25) this.toFreeze.push(id)
      }
    } else this.rest.set(id, 0)
  }

  end(): void {
    const { toThaw, toFreeze, rob, robR } = this
    // the robot wakes whatever it could touch before the next look
    for (const n of this.near(rob.x, rob.y, robR)) toThaw.push(n)

    for (const id of toThaw) this.thawId(id)
    for (const id of toFreeze.sort((a, b) => a - b)) {
      if (this.frozen.has(id)) continue
      this.host.freeze(id)
      const p = this.host.position(id)
      this.rest.delete(id)
      if (p) this.addFrozen(id, p[0], p[1])
    }
  }

  step(): void {
    this.begin()
    this.host.forEachActive((id, b) => this.observe(id, b.translation(), b.linvel(), b))
    this.end()
  }
}
