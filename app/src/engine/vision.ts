// Vision simulation: a robot-mounted camera that sees AprilTags on the field, and the pose estimate a vision pipeline would hand the robot code.
// The tag layout is FIRST's official 2026 REBUILT layout (the WPILib AprilTagFieldLayout 2026-rebuilt-welded.json, 32 tags); it agrees with the field CAD to 3.3 mm.
import { Noise } from './bridge/faults'

export interface Tag { id: number; x: number; y: number; z: number; /** the direction the tag faces, rad */ facing: number; label: string }

const rad = (d: number): number => (d * Math.PI) / 180
/** Field frame: origin at the blue wall corner, +X toward the red wall. facing is the tag's yaw in the layout (the direction its face points). */
export const TAGS: Tag[] = [
  { id: 1, x: 11.878, y: 7.4248, z: 0.889, facing: rad(180), label: 'red TRENCH' },
  { id: 2, x: 11.9154, y: 4.638, z: 1.124, facing: rad(90), label: 'red HUB' },
  { id: 3, x: 11.3119, y: 4.3902, z: 1.124, facing: rad(180), label: 'red HUB' },
  { id: 4, x: 11.3119, y: 4.0346, z: 1.124, facing: rad(180), label: 'red HUB' },
  { id: 5, x: 11.9154, y: 3.4312, z: 1.124, facing: rad(-90), label: 'red HUB' },
  { id: 6, x: 11.878, y: 0.6445, z: 0.889, facing: rad(180), label: 'red TRENCH' },
  { id: 7, x: 11.9529, y: 0.6445, z: 0.889, facing: rad(0), label: 'red TRENCH' },
  { id: 8, x: 12.271, y: 3.4312, z: 1.124, facing: rad(-90), label: 'red HUB' },
  { id: 9, x: 12.5192, y: 3.679, z: 1.124, facing: rad(0), label: 'red HUB' },
  { id: 10, x: 12.5192, y: 4.0346, z: 1.124, facing: rad(0), label: 'red HUB' },
  { id: 11, x: 12.271, y: 4.638, z: 1.124, facing: rad(90), label: 'red HUB' },
  { id: 12, x: 11.9529, y: 7.4248, z: 0.889, facing: rad(0), label: 'red TRENCH' },
  { id: 13, x: 16.5333, y: 7.4033, z: 0.5524, facing: rad(180), label: 'red TOWER / OUTPOST wall' },
  { id: 14, x: 16.5333, y: 6.9715, z: 0.5524, facing: rad(180), label: 'red TOWER / OUTPOST wall' },
  { id: 15, x: 16.533, y: 4.3236, z: 0.5524, facing: rad(180), label: 'red TOWER / OUTPOST wall' },
  { id: 16, x: 16.533, y: 3.8918, z: 0.5524, facing: rad(180), label: 'red TOWER / OUTPOST wall' },
  { id: 17, x: 4.6631, y: 0.6445, z: 0.889, facing: rad(0), label: 'blue TRENCH' },
  { id: 18, x: 4.6256, y: 3.4312, z: 1.124, facing: rad(-90), label: 'blue HUB' },
  { id: 19, x: 5.2292, y: 3.679, z: 1.124, facing: rad(0), label: 'blue HUB' },
  { id: 20, x: 5.2292, y: 4.0346, z: 1.124, facing: rad(0), label: 'blue HUB' },
  { id: 21, x: 4.6256, y: 4.638, z: 1.124, facing: rad(90), label: 'blue HUB' },
  { id: 22, x: 4.6631, y: 7.4248, z: 0.889, facing: rad(0), label: 'blue TRENCH' },
  { id: 23, x: 4.5882, y: 7.4248, z: 0.889, facing: rad(180), label: 'blue TRENCH' },
  { id: 24, x: 4.27, y: 4.638, z: 1.124, facing: rad(90), label: 'blue HUB' },
  { id: 25, x: 4.0219, y: 4.3902, z: 1.124, facing: rad(180), label: 'blue HUB' },
  { id: 26, x: 4.0219, y: 4.0346, z: 1.124, facing: rad(180), label: 'blue HUB' },
  { id: 27, x: 4.27, y: 3.4312, z: 1.124, facing: rad(-90), label: 'blue HUB' },
  { id: 28, x: 4.5882, y: 0.6445, z: 0.889, facing: rad(180), label: 'blue TRENCH' },
  { id: 29, x: 0.0077, y: 0.666, z: 0.5524, facing: rad(0), label: 'blue TOWER / OUTPOST wall' },
  { id: 30, x: 0.0077, y: 1.0978, z: 0.5524, facing: rad(0), label: 'blue TOWER / OUTPOST wall' },
  { id: 31, x: 0.0081, y: 3.7457, z: 0.5524, facing: rad(0), label: 'blue TOWER / OUTPOST wall' },
  { id: 32, x: 0.0081, y: 4.1775, z: 0.5524, facing: rad(0), label: 'blue TOWER / OUTPOST wall' },
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
