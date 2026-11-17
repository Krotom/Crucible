// A fake robot for the bridge WebSocket channel: a tiny RFC 6455 server that plays the robot side (frc/robot/lib/simbridge/WsServer.java).
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

function frame(payload: Uint8Array): Buffer {
  const n = payload.length
  let head: Buffer
  if (n < 126) head = Buffer.from([0x82, n])
  else if (n < 65536) head = Buffer.from([0x82, 126, n >> 8, n & 255])
  else { head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2) }
  return Buffer.concat([head, payload])
}

export interface WsMessage { type: number; body: Uint8Array }

export class FakeRobotWs {
  private server = http.createServer()
  private socket: Duplex | null = null
  private buf = Buffer.alloc(0)
  messages: WsMessage[] = []
  port = 0
  connections = 0
  onConnect: () => void = () => {}
  /** called for every message the app sends, after it is recorded (a lockstep robot answers Step here) */
  onMessage: (m: WsMessage) => void = () => {}

  async start(): Promise<void> {
    this.server.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      this.socket = socket
      this.buf = Buffer.alloc(0)
      this.connections++
      socket.on('data', (d: Buffer) => this.onData(d))
      socket.on('error', () => {})
      this.onConnect()
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }

  stop(): void { this.socket?.destroy(); this.server.close() }

  /** Sends one message to the app: a type byte and the frame. */
  send(type: number, body: Uint8Array): void {
    const m = new Uint8Array(body.length + 1)
    m[0] = type
    m.set(body, 1)
    this.socket?.write(frame(m))
  }

  of(type: number): Uint8Array[] { return this.messages.filter((m) => m.type === type).map((m) => m.body) }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d])
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const opcode = b[0] & 0x0f
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4 } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10 }
      const masked = (b[1] & 0x80) !== 0
      if (b.length < off + (masked ? 4 : 0) + len) return
      const mask = masked ? b.subarray(off, off + 4) : null
      if (masked) off += 4
      const payload = Buffer.from(b.subarray(off, off + len))
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
      this.buf = b.subarray(off + len)
      if (opcode === 2 && payload.length > 0) {
        const m = { type: payload[0], body: new Uint8Array(payload.subarray(1)) }
        this.messages.push(m)
        this.onMessage(m)
      }
    }
  }
}
