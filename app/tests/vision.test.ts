import { describe, expect, it } from 'vitest'
import { Noise } from '../src/engine/bridge/faults'
import { cameraPose, cleanVision, DEFAULT_CAMERA, detectTags, estimatePose, TAGS } from '../src/engine/vision'

describe('the camera', () => {
  it('sits ahead of the robot centre, rotating with the robot', () => {
    expect(cameraPose({ x: 2, y: 3, yaw: 0 }, DEFAULT_CAMERA)).toMatchObject({ x: 2.3, y: 3, z: 0.55 })
    const c = cameraPose({ x: 2, y: 3, yaw: Math.PI / 2 }, DEFAULT_CAMERA); expect(c.x).toBeCloseTo(2); expect(c.y).toBeCloseTo(3.3); expect(c.yaw).toBeCloseTo(Math.PI / 2)
    const left = cameraPose({ x: 0, y: 0, yaw: 0 }, { ...DEFAULT_CAMERA, left: 0.2, forward: 0 }); expect(left.y).toBeCloseTo(0.2)
  })
})

describe('tag detection', () => {
  it('has a tag layout with unique ids, all on the field', () => {
    expect(new Set(TAGS.map((t) => t.id)).size).toBe(TAGS.length)
    for (const t of TAGS) { expect(t.x >= 0 && t.x <= 16.6 && t.y > 0 && t.y < 8.1 && t.z > 0 && t.z < 2.5, 'tag ' + t.id).toBe(true) }
  })
  it('sees the blue HUB tag that faces the robot from the blue start, and not the ones behind or facing away', () => {
    const seen = detectTags({ x: 1.6, y: 4.03, yaw: 0 })
    const ids = seen.map((d) => d.id)
    expect(ids).toContain(1) // the HUB's field-side tag faces the robot
    expect(ids).not.toContain(2); expect(ids).not.toContain(9); expect(ids).not.toContain(5) // facing away, behind the robot, too far
    const d = seen.find((x) => x.id === 1)!
    expect(d.distance).toBeCloseTo(Math.hypot(4.025 - 1.9, 1.2 - 0.55) + 0, 0); expect(Math.abs(d.bearingDeg)).toBeLessThan(2); expect(d.viewAngleDeg).toBeLessThan(2)
  })
  it('respects the field of view, the range and the camera heading', () => {
    expect(detectTags({ x: 1.6, y: 4.03, yaw: Math.PI }).map((d) => d.id)).toContain(10) // turned around: the blue wall tags
    expect(detectTags({ x: 1.6, y: 4.03, yaw: Math.PI / 2 }).map((d) => d.id)).not.toContain(1) // turned 90°: the HUB tag is outside 35°
    expect(detectTags({ x: 1.6, y: 4.03, yaw: 0 }, { ...DEFAULT_CAMERA, maxRange: 1 })).toEqual([]) // too far
    expect(detectTags({ x: 4.0, y: 4.03, yaw: 0 }, { ...DEFAULT_CAMERA, minRange: 0.4 }).map((d) => d.id)).not.toContain(1) // too close (about 0.3 m)
    expect(detectTags({ x: 1.6, y: 4.03, yaw: 0 }, { ...DEFAULT_CAMERA, hfovDeg: 2 }).map((d) => d.id)).toContain(1) // straight ahead even through a keyhole
  })
  it('does not see a tag from far off to the side (its face points away at a grazing angle)', () => {
    const grazing = detectTags({ x: 6.2, y: 0.8, yaw: Math.PI / 2 + 0.25 }) // looking up the field at the HUB's side tags from low on the right
    for (const d of grazing) expect(Math.cos((d.viewAngleDeg * Math.PI) / 180)).toBeGreaterThanOrEqual(0.3)
  })
  it('lists the nearest tag first', () => {
    const seen = detectTags({ x: 1.0, y: 4.03, yaw: 0 }, { ...DEFAULT_CAMERA, pitchDeg: 5, vfovDeg: 80, hfovDeg: 100, maxRange: 12 })
    expect(seen.length).toBeGreaterThan(1); expect(seen.map((d) => d.distance)).toEqual([...seen.map((d) => d.distance)].sort((a, b) => a - b))
  })
})

describe('pose estimate', () => {
  const seen = (n: number, dist: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, distance: dist, bearingDeg: 0, elevationDeg: 0, viewAngleDeg: 0 }))
  it('is null with no tags', () => { expect(estimatePose({ x: 1, y: 2, yaw: 0 }, [], new Noise(1))).toBeNull() })
  it('is exact with the noise level at 0 and near the truth otherwise, repeatably', () => {
    const exact = estimatePose({ x: 1, y: 2, yaw: 0.3 }, seen(2, 3), new Noise(1), 0)!; expect([exact.x, exact.y, exact.yaw]).toEqual([1, 2, 0.3])
    const a = estimatePose({ x: 1, y: 2, yaw: 0.3 }, seen(2, 3), new Noise(5))!, b = estimatePose({ x: 1, y: 2, yaw: 0.3 }, seen(2, 3), new Noise(5))!
    expect(a).toEqual(b); expect(Math.hypot(a.x - 1, a.y - 2)).toBeLessThan(0.5)
  })
  it('is less sure far away and more sure with more tags, and scales with the level', () => {
    const n = new Noise(1)
    const near = estimatePose({ x: 0, y: 0, yaw: 0 }, seen(1, 1), n)!, far = estimatePose({ x: 0, y: 0, yaw: 0 }, seen(1, 5), n)!, many = estimatePose({ x: 0, y: 0, yaw: 0 }, seen(4, 5), n)!
    expect(far.stdXY).toBeGreaterThan(near.stdXY * 5); expect(many.stdXY).toBeCloseTo(far.stdXY / 2, 6); expect(many.tags).toBe(4)
    expect(estimatePose({ x: 0, y: 0, yaw: 0 }, seen(1, 3), n, 2)!.stdXY).toBeCloseTo(2 * estimatePose({ x: 0, y: 0, yaw: 0 }, seen(1, 3), n, 1)!.stdXY, 9)
  })
  it('cleans the settings', () => {
    expect(cleanVision({ enabled: true, noise: 9 })).toEqual({ enabled: true, noise: 3 }); expect(cleanVision(undefined)).toEqual({ enabled: false, noise: 1 }); expect(cleanVision({ enabled: 1 as never, noise: NaN })).toEqual({ enabled: false, noise: 1 })
  })
})
