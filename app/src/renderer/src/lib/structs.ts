// Decoding of WPILib struct-typed values (what AdvantageKit and NT write for Pose2d, Pose3d, ...).
// Only structs made purely of doubles are decoded; everything else stays as raw bytes.

export type Value = number | boolean | string | number[] | string[] | Uint8Array | Float64Array

/** Number of doubles per struct, for the structs whose fields are all doubles. */
export const STRUCT_DOUBLES: Record<string, number> = {
  Rotation2d: 1,
  Translation2d: 2,
  Pose2d: 3,
  Transform2d: 3,
  Twist2d: 3,
  ChassisSpeeds: 3,
  Rotation3d: 4, // quaternion w, x, y, z
  Translation3d: 3,
  Pose3d: 7, // x, y, z, qw, qx, qy, qz
  Transform3d: 7,
  Twist3d: 6,
  SwerveModuleState: 2, // speed, angle (rad)
  SwerveModulePosition: 2, // distance, angle (rad)
}

export interface StructType { name: string; isArray: boolean }

export function parseStructType(type: string): StructType | null {
  if (!type.startsWith('struct:')) return null
  let name = type.slice(7)
  const isArray = name.endsWith('[]')
  if (isArray) name = name.slice(0, -2)
  return { name, isArray }
}

export function structWidth(type: string): number | null {
  const s = parseStructType(type)
  return s ? (STRUCT_DOUBLES[s.name] ?? null) : null
}

/** Decodes a struct or struct array into a flat Float64Array of width * count doubles; null when unsupported or malformed. */
export function decodeStruct(type: string, bytes: Uint8Array): Float64Array | null {
  const w = structWidth(type)
  if (w === null) return null
  const size = w * 8
  if (bytes.byteLength === 0 || bytes.byteLength % size !== 0) return null
  const n = bytes.byteLength / size
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float64Array(w * n)
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8, true)
  return out
}

/** Decodes a log or NT `raw` payload according to its declared type string. */
export function decodeRaw(type: string, bytes: Uint8Array): Value {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (type) {
    case 'boolean': return bytes[0] !== 0
    case 'int64': return Number(dv.getBigInt64(0, true))
    case 'float': return dv.getFloat32(0, true)
    case 'double': return dv.getFloat64(0, true)
    case 'string':
    case 'json': return new TextDecoder().decode(bytes)
    case 'boolean[]': return Array.from(bytes, (b) => (b !== 0 ? 1 : 0))
    case 'int64[]': { const o: number[] = []; for (let i = 0; i + 8 <= bytes.byteLength; i += 8) o.push(Number(dv.getBigInt64(i, true))); return o }
    case 'float[]': { const o: number[] = []; for (let i = 0; i + 4 <= bytes.byteLength; i += 4) o.push(dv.getFloat32(i, true)); return o }
    case 'double[]': { const o: number[] = []; for (let i = 0; i + 8 <= bytes.byteLength; i += 8) o.push(dv.getFloat64(i, true)); return o }
    case 'string[]': {
      const o: string[] = []
      if (bytes.byteLength < 4) return o
      const n = dv.getUint32(0, true)
      let off = 4
      const dec = new TextDecoder()
      for (let i = 0; i < n && off + 4 <= bytes.byteLength; i++) {
        const len = dv.getUint32(off, true); off += 4
        o.push(dec.decode(bytes.subarray(off, off + len))); off += len
      }
      return o
    }
  }
  if (type.startsWith('struct:')) return decodeStruct(type, bytes) ?? bytes
  return bytes
}

/** Types whose value can be drawn on a plot as a single number. */
export function isNumericType(type: string): boolean {
  return type === 'double' || type === 'float' || type === 'int' || type === 'int64' || type === 'boolean'
}
