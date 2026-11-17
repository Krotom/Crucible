// Scripted robots that play the game: they follow a route, or cycle (drive to a pickup spot, take FUEL from the floor, drive to a firing spot, fire at
// their HUB). They are driven through the same traction-limited body as every other robot; this only decides what velocity to ask for and when to
// take or fire a piece. Everything is a function of the state saved below plus the engine's seeded random numbers, so runs repeat.
import type { BotAI, PieceSpawn, Vec3 } from './types'

const G = 9.81

export interface BotHost {
  time: number
  /** a loose piece within radius r of (x, y): its id, or null */
  pieceNear(x: number, y: number, r: number): number | null
  removePiece(id: number): void
  spawn(s: PieceSpawn): number
  /** the seeded random generator */
  rand(): number
  pieceSpec: string
}

export interface BotCommand { vx: number; vy: number; omega: number }

type Phase = 'toPickup' | 'intake' | 'toShoot' | 'shoot'

export interface BotState { wp: number; phase: Phase; phaseT: number; carried: number; nextAct: number; fired: number; taken: number }

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

export class BotController {
  state: BotState = { wp: 0, phase: 'toPickup', phaseT: 0, carried: 0, nextAct: 0, fired: 0, taken: 0 }

  constructor(private ai: BotAI) {}

  save(): BotState { return { ...this.state } }
  load(s: BotState): void { this.state = { ...s } }
  reset(): void { this.state = { wp: 0, phase: 'toPickup', phaseT: 0, carried: 0, nextAct: 0, fired: 0, taken: 0 } }

  /** The command for this step, in the robot's frame (forward, left, counterclockwise). */
  command(pose: { x: number; y: number; yaw: number }, host: BotHost): BotCommand {
    const speed = this.ai.speed ?? 2.5
    let goal: { x: number; y: number } | null = null
    let face: number | null = null // heading to hold, or null = along the way
    const cyc = this.ai.cycle
    if (cyc) {
      const s = this.state
      if (s.phase === 'toPickup') {
        goal = cyc.pickup
        if (Math.hypot(pose.x - goal.x, pose.y - goal.y) < 0.3) { s.phase = 'intake'; s.phaseT = host.time; s.nextAct = host.time }
      } else if (s.phase === 'intake') {
        goal = null
        face = Math.atan2(cyc.pickup.y - pose.y, cyc.pickup.x - pose.x) || pose.yaw
        if (host.time >= s.nextAct && s.carried < cyc.count) {
          s.nextAct = host.time + 0.25
          const id = host.pieceNear(pose.x + Math.cos(pose.yaw) * 0.5, pose.y + Math.sin(pose.yaw) * 0.5, 0.9)
          if (id !== null) { host.removePiece(id); s.carried++; s.taken++ }
        }
        if (s.carried >= cyc.count || host.time - s.phaseT >= cyc.intakeSeconds) { s.phase = 'toShoot'; s.phaseT = host.time }
      } else if (s.phase === 'toShoot') {
        goal = cyc.at
        if (Math.hypot(pose.x - goal.x, pose.y - goal.y) < 0.3) { s.phase = 'shoot'; s.phaseT = host.time; s.nextAct = host.time + 0.3 }
      } else {
        goal = null
        face = Math.atan2(cyc.target[1] - pose.y, cyc.target[0] - pose.x)
        if (host.time >= s.nextAct) {
          if (s.carried > 0) { this.fire(pose, host); s.carried--; s.fired++; s.nextAct = host.time + 1 / cyc.rate }
          else { s.phase = 'toPickup'; s.phaseT = host.time }
        }
      }
    } else if (this.ai.route && this.ai.route.length > 0) {
      goal = this.ai.route[this.state.wp % this.ai.route.length]
      if (Math.hypot(pose.x - goal.x, pose.y - goal.y) < 0.3) this.state.wp++
    }
    let vxw = 0
    let vyw = 0
    let heading = face
    if (goal) {
      const dx = goal.x - pose.x
      const dy = goal.y - pose.y
      const d = Math.hypot(dx, dy)
      const v = Math.min(speed, 2.5 * d) // slow down on arrival
      if (d > 1e-6) { vxw = (dx / d) * v; vyw = (dy / d) * v }
      if (heading === null) heading = Math.atan2(dy, dx)
    }
    const omega = heading === null ? 0 : Math.max(-4, Math.min(4, 4 * wrap(heading - pose.yaw)))
    const c = Math.cos(pose.yaw)
    const sn = Math.sin(pose.yaw)
    return { vx: c * vxw + sn * vyw, vy: -sn * vxw + c * vyw, omega }
  }

  /** Fires one piece at the HUB from the bot's position: a steep arc, with a little spread in speed and direction. */
  private fire(pose: { x: number; y: number }, host: BotHost): void {
    const cyc = this.ai.cycle!
    const target: Vec3 = cyc.target
    const spread = cyc.spread ?? 0.03
    const dx = target[0] - pose.x
    const dy = target[1] - pose.y
    const d = Math.hypot(dx, dy)
    const z0 = 0.55
    let theta = (62 * Math.PI) / 180
    let v = 0
    for (let k = 0; k < 8; k++) {
      const denom = 2 * Math.cos(theta) ** 2 * (d * Math.tan(theta) - (target[2] - z0))
      if (denom > 1e-6) { v = Math.sqrt((G * d * d) / denom); break }
      theta += (4 * Math.PI) / 180
    }
    const gauss = (): number => (host.rand() + host.rand() + host.rand() - 1.5) * 2 // roughly normal, sd about 1
    v *= 1 + spread * gauss()
    const yaw = Math.atan2(dy, dx) + spread * 0.5 * gauss()
    const th = theta + spread * 0.5 * gauss()
    const vel: Vec3 = [v * Math.cos(th) * Math.cos(yaw), v * Math.cos(th) * Math.sin(yaw), v * Math.sin(th)]
    host.spawn({ spec: host.pieceSpec, position: [pose.x, pose.y, z0], velocity: vel })
  }
}
