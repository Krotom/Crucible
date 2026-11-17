// Binary layouts of the sim bridge (protocol 0), little-endian. Mirrors frc/robot/lib/simbridge/FrameCodec.java in the
// robot project; the layouts are specified in docs/NT_CONTRACT.md.

export const PROTOCOL = 0
export const MAGIC_TO_APP = 0x31464253 // "SBF1"
export const MAGIC_FROM_APP = 0x32464253 // "SBF2"

const TO_APP_HEADER = 36
const TO_APP_MOTOR = 16
const FROM_APP_HEADER = 40
const FROM_APP_MOTOR = 28
const FROM_APP_CANCODER = 28
const FROM_APP_PIGEON = 76
const FROM_APP_DIO = 8

export const FLAG_ENABLED = 1
export const FLAG_BROWNOUT = 2

export interface ToAppMotor { id: number; appliedVolts: number; flags: number }
export interface ToApp { seq: bigint; simTime: number; batteryVolts: number; flags: number; motors: ToAppMotor[] }

export interface MotorState { id: number; rotorPositionRot: number; rotorVelocityRps: number; rotorAccelRps2: number }
export interface CancoderState { id: number; positionRot: number; velocityRps: number; absolutePositionRot: number }
export interface PigeonState {
  id: number
  yawDeg: number; pitchDeg: number; rollDeg: number
  yawRateDps: number; pitchRateDps: number; rollRateDps: number
  accelXg: number; accelYg: number; accelZg: number
}
export interface FromApp {
  seq: bigint
  simTime: number
  batteryVolts: number
  motors: MotorState[]
  cancoders: CancoderState[]
  pigeons: PigeonState[]
}

function view(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength) }

/** Decodes a ToApp frame; null when the bytes are not a valid protocol-0 frame. */
export function decodeToApp(bytes: Uint8Array): ToApp | null {
  if (bytes.byteLength < TO_APP_HEADER) return null
  const v = view(bytes)
  if (v.getUint32(0, true) !== MAGIC_TO_APP || v.getUint32(4, true) !== PROTOCOL) return null
  const n = v.getUint16(32, true)
  if (bytes.byteLength < TO_APP_HEADER + n * TO_APP_MOTOR) return null
  const motors: ToAppMotor[] = []
  for (let i = 0; i < n; i++) {
    const o = TO_APP_HEADER + i * TO_APP_MOTOR
    motors.push({ id: v.getInt32(o, true), appliedVolts: v.getFloat64(o + 4, true), flags: v.getUint32(o + 12, true) })
  }
  return { seq: v.getBigUint64(8, true), simTime: v.getFloat64(16, true), batteryVolts: v.getFloat64(24, true), flags: v.getUint16(34, true), motors }
}

export function encodeToApp(f: ToApp): Uint8Array {
  const out = new Uint8Array(TO_APP_HEADER + f.motors.length * TO_APP_MOTOR)
  const v = view(out)
  v.setUint32(0, MAGIC_TO_APP, true); v.setUint32(4, PROTOCOL, true)
  v.setBigUint64(8, f.seq, true); v.setFloat64(16, f.simTime, true); v.setFloat64(24, f.batteryVolts, true)
  v.setUint16(32, f.motors.length, true); v.setUint16(34, f.flags, true)
  f.motors.forEach((m, i) => {
    const o = TO_APP_HEADER + i * TO_APP_MOTOR
    v.setInt32(o, m.id, true); v.setFloat64(o + 4, m.appliedVolts, true); v.setUint32(o + 12, m.flags, true)
  })
  return out
}

export function encodeFromApp(f: FromApp): Uint8Array {
  const size = FROM_APP_HEADER + f.motors.length * FROM_APP_MOTOR + f.cancoders.length * FROM_APP_CANCODER + f.pigeons.length * FROM_APP_PIGEON
  const out = new Uint8Array(size)
  const v = view(out)
  v.setUint32(0, MAGIC_FROM_APP, true); v.setUint32(4, PROTOCOL, true)
  v.setBigUint64(8, f.seq, true); v.setFloat64(16, f.simTime, true); v.setFloat64(24, f.batteryVolts, true)
  v.setUint16(32, f.motors.length, true); v.setUint16(34, f.cancoders.length, true); v.setUint16(36, f.pigeons.length, true); v.setUint16(38, 0, true)
  let o = FROM_APP_HEADER
  for (const m of f.motors) {
    v.setInt32(o, m.id, true); v.setFloat64(o + 4, m.rotorPositionRot, true); v.setFloat64(o + 12, m.rotorVelocityRps, true); v.setFloat64(o + 20, m.rotorAccelRps2, true)
    o += FROM_APP_MOTOR
  }
  for (const c of f.cancoders) {
    v.setInt32(o, c.id, true); v.setFloat64(o + 4, c.positionRot, true); v.setFloat64(o + 12, c.velocityRps, true); v.setFloat64(o + 20, c.absolutePositionRot, true)
    o += FROM_APP_CANCODER
  }
  for (const p of f.pigeons) {
    v.setInt32(o, p.id, true)
    const vals = [p.yawDeg, p.pitchDeg, p.rollDeg, p.yawRateDps, p.pitchRateDps, p.rollRateDps, p.accelXg, p.accelYg, p.accelZg]
    vals.forEach((x, i) => v.setFloat64(o + 4 + i * 8, x, true))
    o += FROM_APP_PIGEON
  }
  return out
}

/** Used by tests and a fake robot: decodes what the robot side decodes. */
export function decodeFromApp(bytes: Uint8Array): FromApp | null {
  if (bytes.byteLength < FROM_APP_HEADER) return null
  const v = view(bytes)
  if (v.getUint32(0, true) !== MAGIC_FROM_APP || v.getUint32(4, true) !== PROTOCOL) return null
  const nm = v.getUint16(32, true), nc = v.getUint16(34, true), np = v.getUint16(36, true), nd = v.getUint16(38, true)
  if (bytes.byteLength < FROM_APP_HEADER + nm * FROM_APP_MOTOR + nc * FROM_APP_CANCODER + np * FROM_APP_PIGEON + nd * FROM_APP_DIO) return null
  let o = FROM_APP_HEADER
  const motors: MotorState[] = []
  for (let i = 0; i < nm; i++, o += FROM_APP_MOTOR) motors.push({ id: v.getInt32(o, true), rotorPositionRot: v.getFloat64(o + 4, true), rotorVelocityRps: v.getFloat64(o + 12, true), rotorAccelRps2: v.getFloat64(o + 20, true) })
  const cancoders: CancoderState[] = []
  for (let i = 0; i < nc; i++, o += FROM_APP_CANCODER) cancoders.push({ id: v.getInt32(o, true), positionRot: v.getFloat64(o + 4, true), velocityRps: v.getFloat64(o + 12, true), absolutePositionRot: v.getFloat64(o + 20, true) })
  const pigeons: PigeonState[] = []
  for (let i = 0; i < np; i++, o += FROM_APP_PIGEON) {
    const g = (k: number): number => v.getFloat64(o + 4 + k * 8, true)
    pigeons.push({ id: v.getInt32(o, true), yawDeg: g(0), pitchDeg: g(1), rollDeg: g(2), yawRateDps: g(3), pitchRateDps: g(4), rollRateDps: g(5), accelXg: g(6), accelYg: g(7), accelZg: g(8) })
  }
  return { seq: v.getBigUint64(8, true), simTime: v.getFloat64(16, true), batteryVolts: v.getFloat64(24, true), motors, cancoders, pigeons }
}

// ---- control topics (app to robot)

/** gameData: the one character of the Game Data string ('R' or 'B' in 2026), or '' when none has been sent */
export interface DsState { counter: bigint; gameData: string; enabled: boolean; autonomous: boolean; test: boolean; estop: boolean; dsAttached: boolean; alliance: 0 | 1; station: number; matchTime: number }

export function encodeDs(s: DsState): Uint8Array {
  const out = new Uint8Array(24)
  const v = view(out)
  const flags = (s.enabled ? 1 : 0) | (s.autonomous ? 2 : 0) | (s.test ? 4 : 0) | (s.estop ? 8 : 0) | (s.dsAttached ? 16 : 0)
  v.setBigUint64(0, s.counter, true); v.setUint32(8, flags, true); v.setUint8(12, s.alliance); v.setUint8(13, s.station); v.setUint8(14, s.gameData ? s.gameData.charCodeAt(0) : 0); v.setFloat64(16, s.matchTime, true)
  return out
}

export interface JoystickState { counter: bigint; axes: number[]; buttons: bigint; pov: number }

export function encodeJoystick(s: JoystickState): Uint8Array {
  const out = new Uint8Array(72)
  const v = view(out)
  v.setBigUint64(0, s.counter, true)
  for (let i = 0; i < 6; i++) v.setFloat64(8 + i * 8, s.axes[i] ?? 0, true)
  v.setBigUint64(56, s.buttons, true)
  v.setInt16(64, s.pov, true)
  return out
}

export interface PoseSeed { counter: bigint; x: number; y: number; yawRad: number }

export function encodePoseSeed(s: PoseSeed): Uint8Array {
  const out = new Uint8Array(32)
  const v = view(out)
  v.setBigUint64(0, s.counter, true); v.setFloat64(8, s.x, true); v.setFloat64(16, s.y, true); v.setFloat64(24, s.yawRad, true)
  return out
}
