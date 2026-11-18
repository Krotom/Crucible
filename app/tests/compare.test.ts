import { describe, expect, it } from 'vitest'
import type { RunReport } from '../src/analysis/recorder'
import { MatchRecorder } from '../src/renderer/src/lib/analysis'
import { compareReports, parseRunReport, pathChartSvg, scoreChartSvg } from '../src/renderer/src/lib/compare'

const base = (over: Partial<RunReport> = {}): RunReport => ({
  name: 'A', game: 'REBUILT', seed: 1, duration: 30, step: 0.002, final: { blue: 10, red: 4 }, scoreTimeline: [[0, 0, 0], [10, 5, 2], [30, 10, 4]], captures: [1, 2, 3], launches: [], shots: 8, scoredShots: 6, accuracy: 0.75,
  bursts: [], cycleTimes: [5, 6], meanCycle: 5.5, carryTimes: [1, 2, 3], distance: 40, maxSpeed: 3.5, maxZ: 0.12, hits: { count: 2, hardest: 1.5 }, enabledSeconds: 30, status: {}, samples: [{ t: 0, x: 1, y: 1, yaw: 0, speed: 0, held: 0, blue: 0, red: 0, z: 0.12 }, { t: 1, x: 3, y: 2, yaw: 0, speed: 2, held: 1, blue: 0, red: 0, z: 0.12 }], ...over,
})

describe('run report parsing', () => {
  it('accepts a full report and a minimal one (missing parts get defaults)', () => {
    expect(parseRunReport(JSON.stringify(base())).ok).toBe(true)
    const r = parseRunReport(JSON.stringify({ final: { blue: 3, red: 1 } }))
    expect(r.ok && r.report).toMatchObject({ name: 'run', final: { blue: 3, red: 1 }, shots: 0, accuracy: null, samples: [], scoreTimeline: [], hits: { count: 0, hardest: 0 } })
  })
  it('refuses things that are not run reports, saying why', () => {
    for (const [text, why] of [['{oops', 'JSON'], ['42', 'object'], ['{}', 'final score'], ['{"final":{"blue":"x","red":1}}', 'final score'], ['null', 'object']] as const) {
      const r = parseRunReport(text); expect(r.ok, text).toBe(false); expect((r as { error: string }).error).toContain(why)
    }
  })
  it('drops malformed entries instead of choking on them', () => {
    const r = parseRunReport(JSON.stringify({ ...base(), scoreTimeline: [[0, 0, 0], 'x', [1, 2]], samples: [{ t: 1, x: 'a', y: 2 }, { t: 1, x: 2, y: 3 }], cycleTimes: [1, 'z', null, 2] }))
    expect(r.ok && r.report.scoreTimeline).toEqual([[0, 0, 0]]); expect(r.ok && r.report.samples).toHaveLength(1); expect(r.ok && r.report.cycleTimes).toEqual([1, 2])
  })
})

describe('comparison table', () => {
  it('says which run did better where that means something, with signed differences', () => {
    const a = base(), b = base({ name: 'B', final: { blue: 14, red: 2 }, scoredShots: 5, accuracy: 0.5, meanCycle: 4.5, hits: { count: 2, hardest: 3 }, distance: 50, maxSpeed: 3.5 })
    const rows = Object.fromEntries(compareReports(a, b).map((r) => [r.label, r]))
    expect(rows['Blue score']).toMatchObject({ a: '10', b: '14', delta: '+4', better: 'b' })
    expect(rows['Red score']).toMatchObject({ delta: '−2', better: 'b' }) // fewer opponent points is better
    expect(rows['Shots in a HUB']).toMatchObject({ delta: '−1', better: 'a' })
    expect(rows['Accuracy']).toMatchObject({ a: '75%', b: '50%', delta: '−25%', better: 'a' })
    expect(rows['Mean cycle']).toMatchObject({ a: '5.5 s', b: '4.5 s', delta: '−1.0 s', better: 'b' })
    expect(rows['Hardest impact'].better).toBe('a'); expect(rows['Impacts'].better).toBe('same')
    expect(rows['Driven'].better).toBe('none'); expect(rows['Top speed']).toMatchObject({ delta: '0.0 m/s', better: 'same' })
  })
  it('shows dashes where one run has no value (no shots: no accuracy or cycle time)', () => {
    const rows = Object.fromEntries(compareReports(base(), base({ shots: 0, accuracy: null, meanCycle: null, carryTimes: [] })).map((r) => [r.label, r]))
    expect(rows['Accuracy']).toMatchObject({ a: '75%', b: '-', delta: '-', better: 'none' }); expect(rows['Mean cycle'].b).toBe('-'); expect(rows['Median pickup to launch'].b).toBe('-')
  })
})

describe('charts', () => {
  it('draw both runs and escape the names', () => {
    const svg = scoreChartSvg(base({ name: '<a>' }), base({ name: 'B&C' }))
    expect(svg).toContain('A &lt;a&gt;'); expect(svg).toContain('B B&amp;C'); expect((svg.match(/<path /g) ?? []).length).toBe(2); expect(svg).not.toContain('<a>')
    const p = pathChartSvg(base(), base({ samples: [] })); expect((p.match(/<polyline/g) ?? []).length).toBe(1)
  })
  it('survive empty runs', () => {
    const empty = base({ scoreTimeline: [], samples: [], duration: 0 })
    expect(() => scoreChartSvg(empty, empty)).not.toThrow(); expect(scoreChartSvg(empty, empty)).not.toContain('NaN'); expect(pathChartSvg(empty, empty)).not.toContain('NaN')
  })
})

describe('run report from the recorder', () => {
  it('has the command-line report shape, with bursts, cycle times and carry times worked out', () => {
    const r = new MatchRecorder()
    const fr = (time: number, x: number) => ({ time, phase: 'teleop', robot: [x, 2, 0.12, 1, 0, 0, 0], robotSpeed: 2, scores: { blue: 0, red: 0 }, held: [1], status: { hubs: 'blue active' } }) as never
    r.ingest(fr(0, 0), [{ t: 0.5, kind: 'capture', id: 1 }, { t: 0.6, kind: 'capture', id: 2 }])
    r.ingest(fr(2, 4), [{ t: 2, kind: 'launch', id: 1, x: 4, y: 2, z: 0.5, vx: 5, vy: 0, vz: 4, speed: 6 }, { t: 2.4, kind: 'launch', id: 2, x: 4, y: 2, z: 0.5, vx: 5, vy: 0, vz: 4, speed: 6 }])
    r.ingest(fr(2.8, 5), [{ t: 2.8, kind: 'sensor', sensor: 'h', alliance: 'blue', x: 4.6, y: 4, id: 1, enter: true }, { t: 2.8, kind: 'score', alliance: 'blue', points: 1, reason: 'FUEL in blue HUB (teleop)' }])
    r.ingest(fr(9, 6), [{ t: 8, kind: 'launch', id: 3, x: 6, y: 2, z: 0.5, vx: 5, vy: 0, vz: 4, speed: 6 }])
    const rep = r.toRunReport({ name: 'run 1', game: 'REBUILT', seed: 7, step: 0.002 })
    expect(rep).toMatchObject({ name: 'run 1', seed: 7, duration: 9, final: { blue: 1, red: 0 }, shots: 3, scoredShots: 1, captures: [0.5, 0.6], maxSpeed: 2 })
    expect(rep.bursts).toEqual([{ start: 2, end: 2.4, count: 2, scored: 1 }, { start: 8, end: 8, count: 1, scored: 0 }])
    expect(rep.cycleTimes).toEqual([6]); expect(rep.meanCycle).toBe(6); expect(rep.accuracy).toBeCloseTo(1 / 3)
    expect(rep.carryTimes[0]).toBeCloseTo(1.5); expect(rep.launches[0]).toMatchObject({ pieceId: 1, scored: true, scoredAt: 2.8 }); expect(rep.launches[1].scored).toBe(false)
    expect(rep.scoreTimeline).toEqual([[0, 0, 0], [2.8, 1, 0], [9, 1, 0]]); expect(rep.status).toEqual({ hubs: 'blue active' }); expect(rep.samples.length).toBeGreaterThan(3)
    expect(rep.samples[0]).toMatchObject({ x: 0, y: 2, held: 1 })
    // it round-trips through the parser and compares with itself as "same"
    const parsed = parseRunReport(JSON.stringify(rep)); expect(parsed.ok).toBe(true)
    expect(compareReports(rep, (parsed as { report: RunReport }).report).every((row) => row.better === 'same' || row.better === 'none')).toBe(true)
  })
})
