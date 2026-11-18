// Writes a WPILOG file (format version 1.0) from the data store, so a sim run can be opened again here, in AdvantageScope or any WPILOG tool.
// Mirrors the reader in wpilog.ts: a header, then records of (entry id, payload size, timestamp in microseconds, payload); entry 0 carries the control records.
import type { DataStore, Series } from './store'
import type { Value } from './structs'

const enc = new TextEncoder()

class Bytes {
  private parts: number[] = []
  u8(v: number): void { this.parts.push(v & 255) }
  u32(v: number): void { this.parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255) }
  uvar(v: number, len: number): void { for (let i = 0; i < len; i++) this.parts.push(Math.floor(v / 2 ** (8 * i)) & 255) }
  raw(b: ArrayLike<number>): void { for (let i = 0; i < b.length; i++) this.parts.push(b[i]) }
  str(s: string): void { const b = enc.encode(s); this.u32(b.length); this.raw(b) }
  get length(): number { return this.parts.length }
  bytes(): Uint8Array { return Uint8Array.from(this.parts) }
}

const f64 = (v: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b }
const f32 = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b }
const i64 = (v: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(Math.round(v)), true); return b }
const len = (n: number): number => (n < 256 ? 1 : n < 65536 ? 2 : n < 2 ** 24 ? 3 : 4)

/** The WPILOG type name for a store type (the sim's own 'int' is a 64-bit integer). */
export function wpilogType(type: string): string { return type === 'int' ? 'int64' : type }

/** The payload bytes of one sample, by type. */
export function encodeValue(type: string, v: Value): Uint8Array {
  const nums = (): number[] => (typeof v === 'object' && v !== null && !(v instanceof Uint8Array) ? Array.from(v as ArrayLike<number>) : [])
  switch (type) {
    case 'boolean': return Uint8Array.of(v ? 1 : 0)
    case 'int': case 'int64': return i64(Number(v))
    case 'float': return f32(Number(v))
    case 'double': return f64(Number(v))
    case 'string': case 'json': return enc.encode(String(v))
    case 'boolean[]': return Uint8Array.from(nums(), (x) => (x ? 1 : 0))
    case 'int64[]': { const o = new Bytes(); for (const x of nums()) o.raw(i64(x)); return o.bytes() }
    case 'float[]': { const o = new Bytes(); for (const x of nums()) o.raw(f32(x)); return o.bytes() }
    case 'double[]': { const o = new Bytes(); for (const x of nums()) o.raw(f64(x)); return o.bytes() }
    case 'string[]': { const a = Array.isArray(v) ? (v as unknown[]).map(String) : []; const o = new Bytes(); o.u32(a.length); for (const s of a) o.str(s); return o.bytes() }
  }
  if (v instanceof Uint8Array) return v
  // structs the app decodes into numbers (poses, speeds ...) are made of doubles
  return (() => { const o = new Bytes(); for (const x of nums()) o.raw(f64(x)); return o.bytes() })()
}

export class WpilogWriter {
  private out = new Bytes()
  private nextId = 1

  constructor(extraHeader = '') {
    this.out.raw(enc.encode('WPILOG'))
    this.out.u8(0x00); this.out.u8(0x01)
    const extra = enc.encode(extraHeader)
    this.out.u32(extra.length); this.out.raw(extra)
  }

  private record(id: number, tsUs: number, payload: ArrayLike<number>): void {
    const idLen = len(id), sizeLen = len(payload.length), tsLen = Math.min(8, Math.max(1, Math.ceil(Math.log2(tsUs + 1) / 8)))
    this.out.u8((idLen - 1) | ((sizeLen - 1) << 2) | ((tsLen - 1) << 4))
    this.out.uvar(id, idLen); this.out.uvar(payload.length, sizeLen); this.out.uvar(tsUs, tsLen)
    this.out.raw(payload)
  }

  /** Declares an entry; returns its id. */
  start(name: string, type: string, tsUs = 0, metadata = ''): number {
    const id = this.nextId++
    const p = new Bytes()
    p.u8(0); p.u32(id); p.str(name); p.str(type); p.str(metadata)
    this.record(0, tsUs, p.bytes())
    return id
  }

  data(id: number, tsUs: number, payload: ArrayLike<number>): void { this.record(id, Math.max(0, Math.round(tsUs)), payload) }

  bytes(): Uint8Array { return this.out.bytes() }
}

/** Every series of the store as a WPILOG, samples merged in time order. */
export function storeToWpilog(store: DataStore, extraHeader = 'BALTA Crucible'): Uint8Array {
  const w = new WpilogWriter(extraHeader)
  const entries: { id: number; s: Series; type: string }[] = []
  for (const name of store.topicNames()) {
    const s = store.series.get(name)!
    if (s.times.length === 0 || name.startsWith('/.schema')) continue
    const type = wpilogType(s.type)
    entries.push({ id: w.start(name, type, 0), s, type: s.type })
  }
  const all: { t: number; e: (typeof entries)[number]; i: number }[] = []
  for (const e of entries) for (let i = 0; i < e.s.times.length; i++) all.push({ t: e.s.times[i], e, i })
  all.sort((a, b) => a.t - b.t || a.e.id - b.e.id)
  for (const x of all) w.data(x.e.id, x.t * 1e6, encodeValue(x.e.type, x.e.s.get(x.i)))
  return w.bytes()
}
