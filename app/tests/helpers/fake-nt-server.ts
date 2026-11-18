// A minimal in-process NT4 server for contract tests: enough protocol to act as the robot side of the bridge.
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { decodeMulti, encode } from '@msgpack/msgpack'

function frame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length
  let head: Buffer
  if (n < 126) head = Buffer.from([0x80 | opcode, n])
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2) }
  return Buffer.concat([head, payload])
}

export interface ClientValue { pubuid: number; topic: string; type: number; value: unknown }

export class FakeNtServer {
  private server = http.createServer()
  private socket: Duplex | null = null
  private buf = Buffer.alloc(0)
  private nextId = 100
  private topicIds = new Map<string, number>() // announced by us
  private pubuidToTopic = new Map<number, string>() // client publishers
  subscribed = new Set<string>()
  values: ClientValue[] = []
  port = 0

  async start(port = 0): Promise<void> {
    this.server.on('upgrade', (req, socket) => {
      const proto = String(req.headers['sec-websocket-protocol'])
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${proto}\r\n\r\n`)
      this.socket = socket
      this.buf = Buffer.alloc(0)
      socket.on('data', (d: Buffer) => this.onData(d))
      socket.on('error', () => {})
    })
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }

  stop(): void { this.socket?.destroy(); this.server.close() }

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
      if (opcode === 1) this.onText(payload.toString())
      else if (opcode === 2) this.onBinary(new Uint8Array(payload))
    }
  }

  private onText(text: string): void {
    for (const m of JSON.parse(text) as { method: string; params: { name?: string; topics?: string[]; pubuid?: number } }[]) {
      if (m.method === 'publish' && m.params.name) this.pubuidToTopic.set(m.params.pubuid!, m.params.name)
      else if (m.method === 'subscribe') for (const t of m.params.topics ?? []) this.subscribed.add(t)
    }
  }

  private onBinary(bytes: Uint8Array): void {
    for (const msg of decodeMulti(bytes)) {
      const [id, , type, value] = msg as [number, number, number, unknown]
      const topic = this.pubuidToTopic.get(id)
      if (topic) this.values.push({ pubuid: id, topic, type, value })
    }
  }

  /** Announces a topic to the client (once). */
  announce(name: string, type: string): number {
    let id = this.topicIds.get(name)
    if (id === undefined) {
      id = this.nextId++
      this.topicIds.set(name, id)
      const msg = [{ method: 'announce', params: { name, id, type, pubuid: 0, properties: {} } }]
      this.socket?.write(frame(1, Buffer.from(JSON.stringify(msg))))
    }
    return id
  }

  sendRaw(topic: string, bytes: Uint8Array, tsUs: number): void {
    const id = this.announce(topic, 'raw')
    this.socket?.write(frame(2, Buffer.from(encode([id, tsUs, 5, bytes]))))
  }

  sendString(topic: string, value: string, tsUs: number): void {
    const id = this.announce(topic, 'string')
    this.socket?.write(frame(2, Buffer.from(encode([id, tsUs, 4, value]))))
  }

  valuesFor(topic: string): ClientValue[] { return this.values.filter((v) => v.topic === topic) }
}
