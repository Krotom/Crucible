// Nt4Live against a minimal in-process NT4 server (raw RFC 6455 framing, same approach as spikes/s1b-ws-echo.js).
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { encode } from '@msgpack/msgpack'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Nt4Live } from '../src/renderer/src/lib/nt4'
import { DataStore } from '../src/renderer/src/lib/store'

function frame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
  return Buffer.concat([head, payload])
}

const f64 = (...v: number[]): Uint8Array => new Uint8Array(Float64Array.from(v).buffer)

let server: http.Server
let port = 0
let subscribeSeen: unknown = null
let protocolSeen = ''

beforeAll(async () => {
  server = http.createServer()
  server.on('upgrade', (req, socket) => {
    protocolSeen = String(req.headers['sec-websocket-protocol'])
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocolSeen}\r\n\r\n`)
    socket.on('data', (d: Buffer) => {
      const len = d[1] & 0x7f
      const mask = d.subarray(2, 6)
      const payload = Buffer.from(d.subarray(6, 6 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      if ((d[0] & 0x0f) !== 1) return
      subscribeSeen = JSON.parse(payload.toString())
      const announce = [
        { method: 'announce', params: { name: '/Swerve/Pose', id: 5, type: 'struct:Pose2d', pubuid: 0, properties: {} } },
        { method: 'announce', params: { name: '/Shooter/Rpm', id: 6, type: 'double', pubuid: 0, properties: {} } },
        { method: 'announce', params: { name: '/Flags', id: 7, type: 'boolean[]', pubuid: 0, properties: {} } },
      ]
      socket.write(frame(1, Buffer.from(JSON.stringify(announce))))
      const bin = Buffer.concat([
        Buffer.from(encode([5, 2_000_000, 5, f64(1, 2, 0.5)])),
        Buffer.from(encode([6, 2_010_000, 1, 3500.5])),
        Buffer.from(encode([7, 2_020_000, 16, [true, false]])),
        Buffer.from(encode([-1, 0, 2, 12345])), // time sync reply, must be ignored
        Buffer.from(encode([5, 3_000_000, 5, f64(4, 5, 1.5)])),
      ])
      socket.write(frame(2, bin))
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(() => { server.close() })

describe('Nt4Live', () => {
  it('subscribes to every topic and records decoded values', async () => {
    const store = new DataStore()
    const statuses: string[] = []
    const live = new Nt4Live(store, '127.0.0.1', port, (s) => statuses.push(s))
    live.start()
    await expect.poll(() => store.series.get('/Swerve/Pose')?.times.length ?? 0, { timeout: 3000 }).toBe(2)
    live.stop()

    expect(protocolSeen).toContain('v4.1.networktables.first.wpi.edu')
    expect((subscribeSeen as { params: { topics: string[]; options: { prefix: boolean } } }[])[0].params).toMatchObject({ topics: [''], options: { prefix: true } })
    expect(Array.from(store.valueAt('/Swerve/Pose', 2.5) as Float64Array)).toEqual([1, 2, 0.5])
    expect(Array.from(store.valueAt('/Swerve/Pose', 3.5) as Float64Array)).toEqual([4, 5, 1.5])
    expect(store.valueAt('/Shooter/Rpm', 3)).toBe(3500.5)
    expect(store.valueAt('/Flags', 3)).toEqual([true, false])
    expect(store.mode).toBe('live')
    expect(store.tMax).toBe(3)
    expect(statuses).toContain('connected')
  })
})
