import { describe, expect, it } from 'vitest'
import { DataStore } from '../src/renderer/src/lib/store'
import { encodeValue, storeToWpilog, WpilogWriter, wpilogType } from '../src/renderer/src/lib/wpilogwriter'
import { decodeRaw } from '../src/renderer/src/lib/structs'
import { parseWpilog } from '../src/renderer/src/lib/wpilog'

describe('wpilog value encoding', () => {
  it('round trips every supported type through the decoder', () => {
    const cases: [string, unknown][] = [
      ['double', 3.25], ['float', 1.5], ['int64', -42], ['int', 7], ['boolean', true], ['boolean', false], ['string', 'héllo'], ['json', '{"a":1}'],
      ['double[]', [1, 2.5, -3]], ['float[]', [0.5, 4]], ['int64[]', [5, -6]], ['boolean[]', [1, 0, 1]], ['string[]', ['a', 'bc', '']],
    ]
    for (const [type, value] of cases) {
      const back = decodeRaw(wpilogType(type), encodeValue(type, value as never))
      expect(back, type).toEqual(value === true ? true : value === false ? false : value)
    }
  })
  it('writes poses (doubles) and keeps raw bytes as they are', () => {
    const pose = decodeRaw('struct:Pose2d', encodeValue('struct:Pose2d', Float64Array.of(1, 2, 0.5)))
    expect(Array.from(pose as Float64Array)).toEqual([1, 2, 0.5])
    expect(Array.from(encodeValue('raw', Uint8Array.of(9, 8, 7)))).toEqual([9, 8, 7])
  })
})

describe('wpilog writer', () => {
  it('writes a file the reader opens: entries, times, values, in order', () => {
    const w = new WpilogWriter('test')
    const a = w.start('/A', 'double'); const b = w.start('/B', 'string')
    w.data(a, 1_000_000, encodeValue('double', 1)); w.data(b, 1_500_000, encodeValue('string', 'x')); w.data(a, 2_000_000, encodeValue('double', 2))
    const log = parseWpilog(w.bytes())
    expect(log.entries.map((e) => [e.name, e.type, e.times])).toEqual([['/A', 'double', [1, 2]], ['/B', 'string', [1.5]]])
    expect(log.tMin).toBe(1); expect(log.tMax).toBe(2); expect(log.truncated).toBe(false)
  })
  it('handles big ids, big payloads and big timestamps (variable-length fields)', () => {
    const w = new WpilogWriter()
    let last = 0; for (let i = 0; i < 300; i++) last = w.start('/E' + i, 'double')
    const big = new Uint8Array(70_000).fill(5)
    const s = w.start('/Big', 'raw'); w.data(s, 3_600_000_000, big); w.data(last, 4_000_000_000_000, encodeValue('double', 9))
    const log = parseWpilog(w.bytes())
    expect(log.entries).toHaveLength(301)
    const bigEntry = log.entries.find((e) => e.name === '/Big')!; expect(bigEntry.lengths[0]).toBe(70_000); expect(bigEntry.times[0]).toBe(3600)
    expect(log.entries.find((e) => e.name === '/E299')!.times[0]).toBe(4_000_000)
  })
})

describe('store export', () => {
  it('turns a live store into a log with the same topics, samples and values', () => {
    const store = new DataStore(); store.startLive('Sim')
    const pose = store.liveSeries('/Sim/Robot/Pose', 'struct:Pose2d'); const score = store.liveSeries('/Sim/Score/Blue', 'int'); const phase = store.liveSeries('/Sim/Phase', 'string'); const beam = store.liveSeries('/Sim/Beam0', 'boolean')
    for (let i = 0; i < 50; i++) { const t = i * 0.05; pose.push(t, Float64Array.of(i, i * 2, 0.1)); score.push(t, Math.floor(i / 10)); phase.push(t, i < 25 ? 'auto' : 'teleop'); beam.push(t, i % 2 === 0) }
    const log = parseWpilog(storeToWpilog(store))
    expect(log.entries.map((e) => e.name).sort()).toEqual(['/Sim/Beam0', '/Sim/Phase', '/Sim/Robot/Pose', '/Sim/Score/Blue'])
    expect(log.entries.find((e) => e.name === '/Sim/Score/Blue')!.type).toBe('int64')
    const back = new DataStore(); back.loadLog(log, 'x')
    expect(back.valueAt('/Sim/Score/Blue', 1.0)).toBe(2); expect(back.valueAt('/Sim/Phase', 1.0)).toBe('auto'); expect(back.valueAt('/Sim/Phase', 1.3)).toBe('teleop'); expect(back.valueAt('/Sim/Beam0', 0.1)).toBe(true)
    expect(Array.from(back.valueAt('/Sim/Robot/Pose', 0.5) as Float64Array)).toEqual([10, 20, 0.1])
    expect(back.series.get('/Sim/Robot/Pose')!.times).toHaveLength(50); expect(back.tMax).toBeCloseTo(2.45, 6)
  })
  it('skips empty series and schema entries; an empty store gives a valid empty log', () => {
    const store = new DataStore(); store.startLive('Sim'); store.liveSeries('/Empty', 'double')
    const log = parseWpilog(storeToWpilog(store)); expect(log.entries).toHaveLength(0)
  })
})
