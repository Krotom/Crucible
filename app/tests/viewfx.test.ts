import { describe, expect, it } from 'vitest'
import type { RenderFrame } from '../src/engine/types'
import { buildSimModel, scoreboardModel } from '../src/renderer/src/lib/simmodel'
import { arcPoints, CAMERA_PRESETS, nextPreset } from '../src/renderer/src/lib/viewfx'

describe('camera presets', () => {
  it('cycles forwards and backwards through every preset and wraps', () => {
    const ids = CAMERA_PRESETS.map((p) => p.id)
    let p = ids[0]
    const seen: string[] = []
    for (let i = 0; i < ids.length; i++) { seen.push(p); p = nextPreset(p, 1) }
    expect(seen).toEqual(ids); expect(p).toBe(ids[0])
    expect(nextPreset(ids[0], -1)).toBe(ids[ids.length - 1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('shot arc', () => {
  it('starts at the launch point, ends on the floor, and peaks where the physics says', () => {
    const pts = arcPoints({ x: 2, y: 3, z: 0.5, vx: 6, vy: 1, vz: 5 }, 40)
    expect(pts.slice(0, 3)).toEqual([2, 3, 0.5])
    const last = pts.slice(-3)
    expect(last[2]).toBeCloseTo(0, 6)
    const zs = pts.filter((_, i) => i % 3 === 2)
    const peak = Math.max(...zs)
    expect(peak).toBeCloseTo(0.5 + (5 * 5) / (2 * 9.81), 1)
    const flight = (5 + Math.sqrt(25 + 2 * 9.81 * 0.5)) / 9.81
    expect(last[0]).toBeCloseTo(2 + 6 * flight, 5); expect(last[1]).toBeCloseTo(3 + flight, 5)
    expect(pts.length).toBe(41 * 3)
  })
  it('handles a flat launch from the floor without NaN', () => {
    const pts = arcPoints({ x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0 })
    expect(pts.every(Number.isFinite)).toBe(true)
  })
})

const frame = (over: Partial<RenderFrame> = {}): RenderFrame => ({
  time: 12.5, phase: 'shift1', scores: { blue: 7, red: 3 }, robot: [1.6, 4, 0, 1, 0, 0, 0], robotSpeed: 0, others: [],
  impacts: { count: 0, peak: 0 }, pieceCount: 0, awakeCount: 0, piecePositions: new Float32Array(0), pieceSpecIndex: new Uint8Array(0),
  status: { hubs: 'blue active   red INACTIVE' }, hash: 'x', held: [], beams: [], capture: null, shots: 0, captured: 0, ...over,
} as RenderFrame)

describe('scoreboard model', () => {
  const phases = [{ name: 'auto', duration: 20 }, { name: 'delay', duration: 3 }, { name: 'shift1', duration: 137 }, { name: 'ended', duration: Infinity }]
  it('counts the match clock down and reads the HUB status', () => {
    const m = scoreboardModel(frame(), phases)
    expect(m).toEqual({ blue: 7, red: 3, clock: '2:27', phase: 'Shift 1', hubs: { blue: 'active', red: 'inactive' }, shotsIn: null, shotsFired: 0 })
    expect(scoreboardModel(frame({ time: 0 }), phases).clock).toBe('2:40')
    expect(scoreboardModel(frame({ time: 999 }), phases).clock).toBe('0:00')
  })
  it('shows the successful shots of the robot next to the score', () => {
    const m = scoreboardModel(frame({ shots: 9 }), phases, 6)
    expect(m.shotsIn).toBe(6)
    expect(m.shotsFired).toBe(9)
  })
  it('has no HUB info when the game does not report it', () => {
    expect(scoreboardModel(frame({ status: {} }), phases).hubs).toBeNull()
  })
})

describe('distance to your HUB', () => {
  const hubs = [{ x: 4.6, y: 4, alliance: 'blue' }, { x: 11.9, y: 4, alliance: 'red' }, { x: 4.6, y: 1, alliance: 'blue' }]
  it('uses the nearest scoring volume of the robot alliance', () => {
    const m = buildSimModel(frame(), { running: true, simRate: 1, bridge: null, hubs, alliance: 'blue' })
    const row = m.sections.find((s) => s.id === 'field')!.rows.find((r) => r.id === 'hubdist')!
    expect(row).toMatchObject({ label: 'To your HUB', value: '3.00 m' })
    const red = buildSimModel(frame({ robot: [14.9, 4, 0, 1, 0, 0, 0] }), { running: true, simRate: 1, bridge: null, hubs, alliance: 'red' })
    expect(red.sections.find((s) => s.id === 'field')!.rows.find((r) => r.id === 'hubdist')!.value).toBe('3.00 m')
  })
  it('has no row without scoring volumes', () => {
    const m = buildSimModel(frame(), { running: true, simRate: 1, bridge: null })
    expect(m.sections.find((s) => s.id === 'field')!.rows.some((r) => r.id === 'hubdist')).toBe(false)
  })
})
