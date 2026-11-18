import { describe, expect, it } from 'vitest'
import { anyBreak, cleanBreaks, matchBreak, NO_BREAKS } from '../src/engine/breaks'
import type { UiEvent } from '../src/engine/protocol'

const launch: UiEvent = { t: 1, kind: 'launch', id: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 8.25 }
const capture: UiEvent = { t: 1, kind: 'capture', id: 2 }
const score: UiEvent = { t: 1, kind: 'score', alliance: 'blue', points: 1, reason: 'FUEL in blue HUB (auto)' }
const foul: UiEvent = { t: 1, kind: 'score', alliance: 'red', points: 15, reason: 'G407: launched from outside the zone' }
const hit = (speed: number): UiEvent => ({ t: 1, kind: 'impact', against: 'field', speed })
const phase: UiEvent = { t: 1, kind: 'phase', from: 'auto', to: 'teleop' }
const on = (o: Partial<typeof NO_BREAKS>) => ({ ...NO_BREAKS, ...o })

describe('breakpoint matching', () => {
  it('does nothing when nothing is switched on', () => {
    expect(matchBreak([launch, capture, score, foul, hit(9), phase], NO_BREAKS, 99, false)).toBeNull(); expect(anyBreak(NO_BREAKS)).toBe(false)
  })
  it('stops for each kind of event, naming it', () => {
    expect(matchBreak([launch], on({ launch: true }), 0, false)?.reason).toBe('shot launched at 8.3 m/s')
    expect(matchBreak([capture], on({ capture: true }), 0, false)?.reason).toBe('FUEL picked up')
    expect(matchBreak([score], on({ score: true }), 0, false)?.reason).toBe('blue scored +1: FUEL in blue HUB (auto)')
    expect(matchBreak([foul], on({ foul: true }), 0, false)?.reason).toBe('foul: G407: launched from outside the zone')
    expect(matchBreak([phase], on({ phase: true }), 0, false)?.reason).toBe('phase teleop')
    expect(matchBreak([hit(3.14)], on({ impact: 2 }), 0, false)?.reason).toBe('impact 3.1 m/s (wall)')
  })
  it('keeps scores and fouls apart, and ignores events it was not asked about', () => {
    expect(matchBreak([foul], on({ score: true }), 0, false)).toBeNull(); expect(matchBreak([score], on({ foul: true }), 0, false)).toBeNull()
    expect(matchBreak([launch, capture], on({ score: true, phase: true }), 0, false)).toBeNull(); expect(matchBreak([hit(1.5)], on({ impact: 2 }), 0, false)).toBeNull()
  })
  it('takes the first matching event of several, in order', () => {
    expect(matchBreak([capture, launch, score], on({ launch: true, score: true }), 0, false)?.reason).toContain('shot launched')
  })
  it('stops once at a given sim time, not again until it is re-armed', () => {
    const b = on({ time: 10 })
    expect(matchBreak([], b, 9.99, false)).toBeNull()
    const first = matchBreak([], b, 10.002, false); expect(first).toEqual({ reason: 'sim time 10 s reached', timeFired: true })
    expect(matchBreak([], b, 10.2, true)).toBeNull()
  })
  it('cleans the settings: unknown values off, numbers clamped', () => {
    expect(cleanBreaks({ launch: true, capture: 'yes' as never, impact: 999, time: -5 })).toEqual({ ...NO_BREAKS, launch: true, impact: 50, time: 0 })
    expect(cleanBreaks({ impact: NaN })).toEqual(NO_BREAKS); expect(cleanBreaks(undefined)).toEqual(NO_BREAKS); expect(anyBreak(cleanBreaks({ time: 5 }))).toBe(true)
  })
})
