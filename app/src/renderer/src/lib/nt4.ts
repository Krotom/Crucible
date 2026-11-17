// NetworkTables 4 client for the live view: subscribes to every topic and feeds the DataStore.
import { decodeMulti } from '@msgpack/msgpack'
import type { DataStore } from './store'
import { decodeRaw, type Value } from './structs'

const PROTOCOL = 'v4.1.networktables.first.wpi.edu'

export type NtStatus = 'connecting' | 'connected' | 'closed'

interface Announced { name: string; type: string }

export class Nt4Live {
  private ws: WebSocket | null = null
  private topics = new Map<number, Announced>()
  private stopped = false
  private retry: ReturnType<typeof setTimeout> | null = null
  constructor(private store: DataStore, private host: string, private port: number, private onStatus: (s: NtStatus) => void) {}

  start(): void {
    this.stopped = false
    this.store.startLive(`NT ${this.host}:${this.port}`)
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close()
    this.ws = null
    this.onStatus('closed')
  }

  private open(): void {
    this.onStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${this.host}:${this.port}/nt/crucible`, PROTOCOL)
    } catch {
      this.scheduleRetry()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.onStatus('connected')
      this.topics.clear()
      ws.send(JSON.stringify([{ method: 'subscribe', params: { topics: [''], subuid: 1, options: { prefix: true, periodic: 0.01 } } }]))
    }
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onText(ev.data) : this.onBinary(new Uint8Array(ev.data as ArrayBuffer)))
    ws.onclose = () => { if (!this.stopped) { this.onStatus('connecting'); this.scheduleRetry() } }
    ws.onerror = () => { /* onclose follows */ }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    this.retry = setTimeout(() => this.open(), 1000)
  }

  private onText(text: string): void {
    for (const m of JSON.parse(text) as { method: string; params: { id: number; name: string; type: string } }[]) {
      if (m.method === 'announce') this.topics.set(m.params.id, { name: m.params.name, type: m.params.type })
      else if (m.method === 'unannounce') this.topics.delete(m.params.id)
    }
  }

  private onBinary(bytes: Uint8Array): void {
    for (const msg of decodeMulti(bytes)) {
      const [id, tsUs, , value] = msg as [number, number, number, unknown]
      if (id < 0) continue
      const topic = this.topics.get(id)
      if (!topic) continue
      const t = Number(tsUs) / 1e6
      let v: Value
      if (value instanceof Uint8Array) v = decodeRaw(topic.type, value)
      else if (typeof value === 'bigint') v = Number(value)
      else v = value as Value
      this.store.liveSeries(topic.name, topic.type).push(t, v)
      this.store.touchLive(t)
    }
  }
}
