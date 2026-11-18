// minimal WPILOG writer for UI fixtures
class LogWriter {
  constructor() { this.parts = []; this.parts.push(...Buffer.from('WPILOG'), 0x00, 0x01, 0, 0, 0, 0) }
  u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] }
  str(s) { const b = [...Buffer.from(s)]; return [...this.u32(b.length), ...b] }
  record(id, tsUs, payload) {
    const head = 3 | (3 << 2) | (7 << 4)
    const ts = [...this.u32(tsUs % 2 ** 32), ...this.u32(Math.floor(tsUs / 2 ** 32))]
    this.parts.push(head, ...this.u32(id), ...this.u32(payload.length), ...ts, ...payload)
  }
  start(id, name, type, tsUs = 0) { this.record(0, tsUs, [0, ...this.u32(id), ...this.str(name), ...this.str(type), ...this.str('')]) }
  data(id, tsUs, payload) { this.record(id, tsUs, payload) }
  bytes() { return Uint8Array.from(this.parts) }
}
const f64 = (...v) => [...new Uint8Array(Float64Array.from(v).buffer)]
exports.makeLog = (seconds = 10) => {
  const w = new LogWriter()
  w.start(1, '/Swerve/Pose', 'struct:Pose2d')
  w.start(2, '/Shooter/Speed', 'double')
  for (let i = 0; i <= seconds * 10; i++) {
    const t = i / 10
    w.data(1, 1_000_000 + Math.round(t * 1e6), f64(1 + t, 2 + Math.sin(t), t / 3))
    w.data(2, 1_000_000 + Math.round(t * 1e6), f64(50 * Math.sin(t)))
  }
  return Buffer.from(w.bytes())
}
