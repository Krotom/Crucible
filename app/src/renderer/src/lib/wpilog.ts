// Reader for the WPILib data log format (.wpilog), version 1.0.
// Records are indexed, not decoded: payloads are decoded lazily from the original buffer when a value is asked for.

export interface LogEntry {
  id: number
  name: string
  type: string
  metadata: string
  /** Record timestamps in seconds. */
  times: number[]
  offsets: number[]
  lengths: number[]
}

export interface ParsedLog {
  buffer: Uint8Array
  entries: LogEntry[]
  tMin: number
  tMax: number
  /** True when the file ended in the middle of a record (a robot that lost power); the complete records are still used. */
  truncated: boolean
}

const MAGIC = 'WPILOG'

function readUInt(dv: DataView, off: number, len: number): number {
  let v = 0
  for (let i = len - 1; i >= 0; i--) v = v * 256 + dv.getUint8(off + i)
  return v
}

export function parseWpilog(buffer: Uint8Array): ParsedLog {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (buffer.byteLength < 12 || new TextDecoder().decode(buffer.subarray(0, 6)) !== MAGIC) throw new Error('Not a WPILOG file')
  const version = dv.getUint16(6, true)
  if (version >> 8 !== 1) throw new Error(`Unsupported WPILOG version ${version >> 8}.${version & 0xff}`)
  const extra = dv.getUint32(8, true)
  let pos = 12 + extra
  const byId = new Map<number, LogEntry>()
  const entries: LogEntry[] = []
  const dec = new TextDecoder()
  let tMin = Infinity
  let tMax = -Infinity
  let truncated = false

  while (pos < buffer.byteLength) {
    const head = buffer[pos]
    const idLen = (head & 3) + 1
    const sizeLen = ((head >> 2) & 3) + 1
    const tsLen = ((head >> 4) & 7) + 1
    const hdr = 1 + idLen + sizeLen + tsLen
    if (pos + hdr > buffer.byteLength) { truncated = true; break }
    const id = readUInt(dv, pos + 1, idLen)
    const size = readUInt(dv, pos + 1 + idLen, sizeLen)
    const ts = readUInt(dv, pos + 1 + idLen + sizeLen, tsLen) / 1e6
    const start = pos + hdr
    if (start + size > buffer.byteLength) { truncated = true; break }
    pos = start + size

    if (id === 0) {
      // control record
      if (size < 5) continue
      const kind = buffer[start]
      if (kind === 0) {
        let o = start + 1
        const entryId = dv.getUint32(o, true); o += 4
        const nl = dv.getUint32(o, true); o += 4
        const name = dec.decode(buffer.subarray(o, o + nl)); o += nl
        const tl = dv.getUint32(o, true); o += 4
        const type = dec.decode(buffer.subarray(o, o + tl)); o += tl
        const ml = dv.getUint32(o, true); o += 4
        const metadata = dec.decode(buffer.subarray(o, o + ml))
        const e: LogEntry = { id: entryId, name, type, metadata, times: [], offsets: [], lengths: [] }
        byId.set(entryId, e)
        entries.push(e)
      } else if (kind === 2) {
        const entryId = dv.getUint32(start + 1, true)
        const e = byId.get(entryId)
        if (e) {
          const ml = dv.getUint32(start + 5, true)
          e.metadata = dec.decode(buffer.subarray(start + 9, start + 9 + ml))
        }
      }
      continue
    }
    const e = byId.get(id)
    if (!e) continue
    e.times.push(ts)
    e.offsets.push(start)
    e.lengths.push(size)
    if (ts < tMin) tMin = ts
    if (ts > tMax) tMax = ts
  }
  if (tMin === Infinity) { tMin = 0; tMax = 0 }
  return { buffer, entries, tMin, tMax, truncated }
}
