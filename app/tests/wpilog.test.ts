import { describe, expect, it } from 'vitest'
import { parseWpilog } from '../src/renderer/src/lib/wpilog'
import { decodeRaw, decodeStruct, structWidth } from '../src/renderer/src/lib/structs'
import { DataStore, indexAt } from '../src/renderer/src/lib/store'

// A tiny WPILOG writer, written from the format description, to build fixtures.
class LogWriter {
  private parts: number[] = []
  constructor() {
    this.parts.push(...Buffer.from('WPILOG'), 0x00, 0x01, 0, 0, 0, 0)
  }
  private u32(v: number): number[] { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] }
  private str(s: string): number[] { const b = [...Buffer.from(s)]; return [...this.u32(b.length), ...b] }
  private record(id: number, tsUs: number, payload: number[]): void {
    // fixed 4-byte id, 4-byte size, 8-byte timestamp: bitfield = (4-1) | (4-1)<<2 | (8-1)<<4
    const head = 3 | (3 << 2) | (7 << 4)
    const ts = [...this.u32(tsUs % 2 ** 32), ...this.u32(Math.floor(tsUs / 2 ** 32))]
    this.parts.push(head, ...this.u32(id), ...this.u32(payload.length), ...ts, ...payload)
  }
  start(id: number, name: string, type: string, tsUs = 0): void {
    this.record(0, tsUs, [0, ...this.u32(id), ...this.str(name), ...this.str(type), ...this.str('')])
  }
  data(id: number, tsUs: number, payload: number[]): void { this.record(id, tsUs, payload) }
  bytes(): Uint8Array { return Uint8Array.from(this.parts) }
}

const f64 = (...v: number[]): number[] => [...new Uint8Array(Float64Array.from(v).buffer)]
const i64 = (v: number): number[] => [...new Uint8Array(BigInt64Array.from([BigInt(v)]).buffer)]

describe('wpilog parser', () => {
  it('reads entries, times and values', () => {
    const w = new LogWriter()
    w.start(1, '/Swerve/Pose', 'struct:Pose2d')
    w.start(2, '/Count', 'int64')
    w.data(1, 1_000_000, f64(1, 2, 0.5))
    w.data(2, 1_500_000, i64(7))
    w.data(1, 2_000_000, f64(3, 4, 1.0))
    const log = parseWpilog(w.bytes())
    expect(log.entries.map((e) => e.name)).toEqual(['/Swerve/Pose', '/Count'])
    expect(log.tMin).toBe(1)
    expect(log.tMax).toBe(2)
    const store = new DataStore()
    store.loadLog(log, 'fixture')
    expect(Array.from(store.valueAt('/Swerve/Pose', 1.5) as Float64Array)).toEqual([1, 2, 0.5])
    expect(Array.from(store.valueAt('/Swerve/Pose', 2.5) as Float64Array)).toEqual([3, 4, 1])
    expect(store.valueAt('/Swerve/Pose', 0.5)).toBeUndefined()
    expect(store.valueAt('/Count', 2)).toBe(7)
  })

  it('keeps complete records of a truncated file', () => {
    const w = new LogWriter()
    w.start(1, '/A', 'double')
    w.data(1, 1_000_000, f64(1))
    w.data(1, 2_000_000, f64(2))
    const full = w.bytes()
    const log = parseWpilog(full.subarray(0, full.length - 5))
    expect(log.truncated).toBe(true)
    expect(log.entries[0].times).toEqual([1])
  })

  it('rejects other files', () => {
    expect(() => parseWpilog(new Uint8Array(20))).toThrow('Not a WPILOG')
  })
})

describe('struct decoding', () => {
  it('decodes Pose3d arrays', () => {
    const bytes = Uint8Array.from([...f64(1, 2, 3, 1, 0, 0, 0), ...f64(4, 5, 6, 0, 1, 0, 0)])
    expect(structWidth('struct:Pose3d[]')).toBe(7)
    const d = decodeStruct('struct:Pose3d[]', bytes)!
    expect(d.length).toBe(14)
    expect(d[7]).toBe(4)
  })
  it('refuses a payload of the wrong size and unknown structs', () => {
    expect(decodeStruct('struct:Pose2d', new Uint8Array(23))).toBeNull()
    expect(decodeStruct('struct:Mystery', new Uint8Array(8))).toBeNull()
  })
  it('decodes scalars and string arrays', () => {
    expect(decodeRaw('boolean', Uint8Array.from([1]))).toBe(true)
    expect(decodeRaw('double', Uint8Array.from(f64(2.5)))).toBe(2.5)
    const s = Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 97, 2, 0, 0, 0, 98, 99])
    expect(decodeRaw('string[]', s)).toEqual(['a', 'bc'])
  })
})

describe('indexAt', () => {
  it('finds the last sample at or before t', () => {
    const t = [1, 2, 3]
    expect(indexAt(t, 0.9)).toBe(-1)
    expect(indexAt(t, 1)).toBe(0)
    expect(indexAt(t, 2.9)).toBe(1)
    expect(indexAt(t, 99)).toBe(2)
  })
})
