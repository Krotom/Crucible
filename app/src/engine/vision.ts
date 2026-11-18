// Vision simulation: a robot-mounted camera that sees AprilTags on the field, and the pose estimate a vision pipeline would hand the robot code.
// The tag layout below is ASSUMED (the REBUILT drawings were not available): four tags around each HUB and three on each alliance wall.
// Replace TAGS when the official layout is known.
import { Noise } from './bridge/faults'

export interface Tag { id: number; x: number; y: number; z: number; /** the direction the tag faces, rad */ facing: number; label: string }

const L = 16.541, W = 8.069, HUB_X = 4.625, HUB_Y = W / 2, HUB_HALF = 0.6
export const TAGS: Tag[] = [
  // around the blue HUB, facing away from it
  { id: 1, x: HUB_X - HUB_HALF, y: HUB_Y, z: 1.2, facing: Math.PI, label: 'blue HUB, field side' },
  { id: 2, x: HUB_X + HUB_HALF, y: HUB_Y, z: 1.2, facing: 0, label: 'blue HUB, neutral side' },
  { id: 3, x: HUB_X, y: HUB_Y - HUB_HALF, z: 1.2, facing: -Math.PI / 2, label: 'blue HUB, right' },
  { id: 4, x: HUB_X, y: HUB_Y + HUB_HALF, z: 1.2, facing: Math.PI / 2, label: 'blue HUB, left' },
  // around the red HUB
  { id: 5, x: L - HUB_X + HUB_HALF, y: HUB_Y, z: 1.2, facing: 0, label: 'red HUB, field side' },
  { id: 6, x: L - HUB_X - HUB_HALF, y: HUB_Y, z: 1.2, facing: Math.PI, label: 'red HUB, neutral side' },
  { id: 7, x: L - HUB_X, y: HUB_Y - HUB_HALF, z: 1.2, facing: -Math.PI / 2, label: 'red HUB, right' },
  { id: 8, x: L - HUB_X, y: HUB_Y + HUB_HALF, z: 1.2, facing: Math.PI / 2, label: 'red HUB, left' },
  // alliance walls
  { id: 9, x: 0, y: HUB_Y - 1.5, z: 0.9, facing: 0, label: 'blue wall' }, { id: 10, x: 0, y: HUB_Y, z: 0.9, facing: 0, label: 'blue wall' }, { id: 11, x: 0, y: HUB_Y + 1.5, z: 0.9, facing: 0, label: 'blue wall' },
  { id: 12, x: L, y: HUB_Y - 1.5, z: 0.9, facing: Math.PI, label: 'red wall' }, { id: 13, x: L, y: HUB_Y, z: 0.9, facing: Math.PI, label: 'red wall' }, { id: 14, x: L, y: HUB_Y + 1.5, z: 0.9, facing: Math.PI, label: 'red wall' },
]

export interface CameraConfig {
  /** where the camera sits on the robot: metres forward and left of the centre, and its height above the floor */
  forward: number; left: number; height: number
  /** where it points, degrees (yaw left of forward, pitch up) */
  yawDeg: number; pitchDeg: number
  hfovDeg: number; vfovDeg: number
  minRange: number; maxRange: number
}

export const DEFAULT_CAMERA: CameraConfig = { forward: 0.3, left: 0, height: 0.55, yawDeg: 0, pitchDeg: 15, hfovDeg: 70, vfovDeg: 55, minRange: 0.4, maxRange: 6 }

export interface RobotPose { x: number; y: number; yaw: number }

export interface Detection {
  id: number
  /** metres from the camera to the tag */
  distance: number
  /** degrees left (+) or right (−) of the camera axis, and up (+) or down (−) */
  bearingDeg: number
  elevationDeg: number
  /** the angle between the tag's face and the line of sight, degrees (0 = looking straight at it) */
  viewAngleDeg: number
}

const deg = (r: number): number => (r * 180) / Math.PI
const rad = (d: number): number => (d * Math.PI) / 180
const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }

/** The camera's place and heading in the field: position (x, y, z) and yaw. */
export function cameraPose(r: RobotPose, c: CameraConfig): { x: number; y: number; z: number; yaw: number } {
  const cy = Math.cos(r.yaw), sy = Math.sin(r.yaw)
  return { x: r.x + c.forward * cy - c.left * sy, y: r.y + c.forward * sy + c.left * cy, z: c.height, yaw: r.yaw + rad(c.yawDeg) }
}

/** The tags the camera sees from this robot pose: in range, inside the field of view and facing the camera. */
export function detectTags(r: RobotPose, c: CameraConfig = DEFAULT_CAMERA, tags: Tag[] = TAGS): Detection[] {
  const cam = cameraPose(r, c)
  const out: Detection[] = []
  for (const t of tags) {
    const dx = t.x - cam.x, dy = t.y - cam.y, dz = t.z - cam.z
    const flat = Math.hypot(dx, dy)
    const dist = Math.hypot(flat, dz)
    if (dist < c.minRange || dist > c.maxRange) continue
    const bearing = wrap(Math.atan2(dy, dx) - cam.yaw)
    const elevation = Math.atan2(dz, flat) - rad(c.pitchDeg)
    if (Math.abs(deg(bearing)) > c.hfovDeg / 2 || Math.abs(deg(elevation)) > c.vfovDeg / 2) continue
    // the tag faces the camera when its normal points roughly at the camera: cos(angle) between the normal and the direction tag -> camera
    const toCam = Math.atan2(-dy, -dx)
    const view = Math.abs(wrap(toCam - t.facing))
    if (Math.cos(view) < 0.3) continue
    out.push({ id: t.id, distance: dist, bearingDeg: deg(bearing), elevationDeg: deg(elevation), viewAngleDeg: deg(view) })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

export interface PoseEstimate { x: number; y: number; yaw: number; tags: number; stdXY: number; stdYawDeg: number }

/**
 * What a vision pipeline reports: the robot pose from the tags it sees, with error that grows with distance and shrinks with more tags
 * (about 1 cm + 1 cm per metre squared, 1° + 0.5° per metre of yaw, divided by the square root of the number of tags). Null when it sees none.
 * `level` scales the error (0 = perfect, 1 = typical, up to 3).
 */
export function estimatePose(r: RobotPose, seen: Detection[], noise: Noise, level = 1): PoseEstimate | null {
  if (seen.length === 0) return null
  const mean = seen.reduce((a, d) => a + d.distance, 0) / seen.length
  const k = Math.sqrt(seen.length)
  const stdXY = ((0.01 + 0.01 * mean * mean) / k) * level
  const stdYaw = ((1 + 0.5 * mean) / k) * level
  return { x: r.x + noise.normal() * stdXY, y: r.y + noise.normal() * stdXY, yaw: wrap(r.yaw + rad(noise.normal() * stdYaw)), tags: seen.length, stdXY, stdYawDeg: stdYaw }
}

export interface VisionMessage { t: number; tags: Detection[]; pose: PoseEstimate | null }

export interface VisionSettings { enabled: boolean; /** error scale, 0 to 3 */ noise: number }
export const NO_VISION: VisionSettings = { enabled: false, noise: 1 }
export function cleanVision(v: Partial<VisionSettings> | undefined): VisionSettings {
  return { enabled: v?.enabled === true, noise: typeof v?.noise === 'number' && Number.isFinite(v.noise) ? Math.min(3, Math.max(0, v.noise)) : 1 }
}
