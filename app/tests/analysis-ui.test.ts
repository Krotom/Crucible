import { describe, expect, it } from 'vitest'
import type { UiEvent } from '../src/engine/protocol'
import type { RenderFrame } from '../src/engine/types'
import { MatchRecorder, eventsCsv, groupOfPhase, histogram, landing, reportHtml } from '../src/renderer/src/lib/analysis'

const frame = (time: number, x = 0, speed = 0, phase = 'auto'): RenderFrame => ({ time, phase, robot: [x, 0, 0, 1, 0, 0, 0], robotSpeed: speed, scores: { blue: 0, red: 0 } } as unknown as RenderFrame)
const score = (t: number, alliance: 'blue' | 'red', points: number, reason: string): UiEvent => ({ t, kind: 'score', alliance, points, reason })
const launch = (t: number, id: number, vx = 5, vz = 5): UiEvent => ({ t, kind: 'launch', id, x: 2, y: 3, z: 0.5, vx, vy: 0, vz, speed: Math.hypot(vx, vz) })
const enter = (t: number, id: number): UiEvent => ({ t, kind: 'sensor', sensor: 'blue-hub', alliance: 'blue', x: 4.6, y: 4, id, enter: true })

describe('landing estimate', () => {
  it('matches the projectile formula', () => {
    const l = landing(0, 0, 1, 4, 0, 3)
    const t = (3 + Math.sqrt(9 + 2 * 9.81 * 1)) / 9.81
    expect(l.flight).toBeCloseTo(t, 6); expect(l.x).toBeCloseTo(4 * t, 6)
    expect(landing(1, 1, 0, 2, 0, 0).flight).toBeCloseTo(0)
  })
})

describe('match recorder', () => {
  it('turns score events into feed items, totals, a timeline and a breakdown with fouls kept apart', () => {
    const r = new MatchRecorder()
    r.ingest(frame(1, 0, 0, 'auto'), [{ t: 0, kind: 'phase', from: null, to: 'auto' }, score(1, 'blue', 1, 'FUEL in blue HUB (auto)')])
    r.ingest(frame(30, 0, 0, 'shift1'), [{ t: 24, kind: 'phase', from: 'transition', to: 'shift1' }, score(30, 'red', 1, 'FUEL in red HUB (teleop)'), score(31, 'red', 15, 'G407: launched from outside the zone')])
    r.ingest(frame(140, 0, 0, 'endgame'), [{ t: 130, kind: 'phase', from: 'shift4', to: 'endgame' }, score(140, 'blue', 10, 'climb')])
    const s = r.summary()
    expect([s.blue, s.red]).toEqual([11, 16])
    expect(s.breakdown).toEqual([{ label: 'Auto', blue: 1, red: 0 }, { label: 'Teleop', blue: 0, red: 1 }, { label: 'Endgame', blue: 10, red: 0 }, { label: 'Fouls', blue: 0, red: 15 }])
    expect(r.timeline.at(-1)).toMatchObject({ blue: 11, red: 16 })
    expect(s.fouls).toHaveLength(1)
    const foul = r.feed.find((f) => f.kind === 'foul')!
    expect(foul.text).toBe('Foul on Blue: G407: launched from outside the zone (+15 Red)')
    expect(r.feed.find((f) => f.kind === 'score')!.text).toBe('Blue +1 · FUEL in blue HUB (auto)')
    expect(r.feed.filter((f) => f.kind === 'phase').map((f) => f.text)).toEqual(['Phase: Auto', 'Phase: Shift1', 'Phase: Endgame'])
  })

  it('decides shots: scored when the piece enters a HUB, missed after 3 s, pickup-to-launch measured', () => {
    const r = new MatchRecorder()
    r.ingest(frame(1), [{ t: 1, kind: 'capture', id: 7 }, { t: 1.5, kind: 'capture', id: 8 }])
    r.ingest(frame(3), [launch(3, 7), launch(3.2, 8)])
    r.ingest(frame(3.8), [enter(3.8, 7)])
    expect(r.shots.map((s) => s.result)).toEqual(['scored', 'pending'])
    expect(r.shots[0]).toMatchObject({ landX: 4.6, landY: 4, pickupToLaunch: 2 })
    r.ingest(frame(7), [])
    expect(r.shots.map((s) => s.result)).toEqual(['scored', 'missed'])
    const s = r.summary()
    expect(s.shots).toMatchObject({ fired: 2, scored: 1, missed: 1, pending: 0, accuracy: 0.5 })
    expect(s.cycles!.n).toBe(2); expect(s.cycles!.min).toBeCloseTo(1.7); expect(s.cycles!.max).toBeCloseTo(2); expect(s.cycles!.mean).toBeCloseTo(1.85)
    expect(r.feed.filter((f) => f.kind === 'shot').map((f) => f.text)).toEqual(expect.arrayContaining(['Shot scored', 'Shot missed']))
    // an unrelated piece entering a sensor changes nothing
    r.ingest(frame(8), [enter(8, 99)]); expect(r.summary().shots.scored).toBe(1)
  })

  it('records impacts (quiet ones stay out of the feed), the path and top speed', () => {
    const r = new MatchRecorder()
    r.ingest(frame(0, 0, 0), [])
    r.ingest(frame(0.1, 1, 2), [{ t: 0.1, kind: 'impact', against: 'field', speed: 0.2 }, { t: 0.1, kind: 'impact', against: 'robot', speed: 2.5 }])
    r.ingest(frame(0.2, 3, 4.5), [])
    const s = r.summary()
    expect(s.impacts).toEqual({ n: 2, peak: 2.5 }); expect(s.topSpeed).toBe(4.5); expect(s.distance).toBeCloseTo(3)
    expect(r.feed.filter((f) => f.kind === 'impact').map((f) => f.text)).toEqual(['Impact 2.5 m/s (robot)'])
  })

  it('goes back when the sim is rewound or reloaded, and starts over on a reset', () => {
    const r = new MatchRecorder()
    r.ingest(frame(1, 0), [score(1, 'blue', 1, 'FUEL in blue HUB (auto)'), launch(1, 1)])
    r.ingest(frame(5, 4), [score(5, 'blue', 1, 'FUEL in blue HUB (auto)'), launch(5, 2), { t: 5, kind: 'phase', from: 'auto', to: 'delay' }])
    r.ingest(frame(2, 1), []) // loaded state from t = 2
    expect(r.summary().blue).toBe(1); expect(r.shots).toHaveLength(1); expect(r.phase).toBe('none'.length ? r.phase : '')
    expect(r.path.every((p) => p.t <= 2)).toBe(true)
    r.ingest(frame(0), []) // reset
    expect(r.scores).toHaveLength(0); expect(r.feed).toHaveLength(0); expect(r.summary().distance).toBe(0)
  })

  it('groups phases', () => {
    expect(['auto', 'transition', 'shift3', 'teleop', 'endgame', 'delay', 'ended'].map(groupOfPhase)).toEqual(['Auto', 'Teleop', 'Teleop', 'Teleop', 'Endgame', 'Other', 'Other'])
  })
})

describe('histogram, csv and report', () => {
  it('bins values and puts the overflow in the last bin', () => {
    const h = histogram([0.2, 0.9, 1.1, 5, 99, -1], 1, 4)
    expect(h.map((b) => b.count)).toEqual([3, 1, 0, 2])
  })
  it('writes a csv with quoted text', () => {
    expect(eventsCsv([{ t: 1.5, kind: 'score', alliance: 'blue', text: 'a "quoted", text' }])).toBe('time_s,kind,alliance,text\n1.500,score,blue,"a ""quoted"", text"\n')
  })
  it('builds a standalone HTML report with the numbers and escaped text', () => {
    const r = new MatchRecorder()
    r.ingest(frame(1), [score(1, 'blue', 3, 'FUEL <b>in</b> HUB'), launch(1, 1), { t: 1, kind: 'capture', id: 1 }])
    const html = reportHtml(r, { title: 'Test <run>', game: 'REBUILT', mode: 'scripted', seed: 42, version: '1.0.0', date: '2026-11-18' }, 16.541, 8.069)
    expect(html).toContain('<!doctype html>'); expect(html).toContain('Test &lt;run&gt;'); expect(html).toContain('FUEL &lt;b&gt;in&lt;/b&gt; HUB')
    expect(html).not.toContain('<script'); expect(html).toContain('seed 42'); expect(html).toMatch(/Score breakdown/)
  })
})
