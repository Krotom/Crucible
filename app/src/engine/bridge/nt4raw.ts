// Small NetworkTables 4 client for the bridge: publishes raw topics and delivers every value of subscribed raw topics.
// Uses the global WebSocket (browser, worker, Node 22+). Reconnects by itself.
import { decodeMulti, encode } from '@msgpack/msgpack'

const PROTOCOL = 'v4.1.networktables.first.wpi.edu'
const TYPE_RAW = 5
const TYPE_STRING = 4

type Handler = (value: Uint8Array) => void

export class Nt4Raw {
  private ws: WebSocket | null = null
  private uid = 1
  private pubIds = new Map<string, number>() // topic -> pubuid
  private pubTypes = new Map<string, string>()
  private subs = new Map<string, Handler>() // topic -> handler
  private idToName = new Map<number, string>()
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private strHandlers = new Map<string, (v: string) => void>()
  /** Called with true when a socket is open and the topic setup was sent, false on loss. */
  onConnection: (connected: boolean) => void = () => {}

  constructor(private host: string, private port: number, private clientName = 'crucible-bridge') {}

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  start(): void { this.stopped = false; this.open() }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  /** Announces a raw topic (sent now if connected, and again after every reconnect). */
  publishRaw(topic: string): void {
    if (this.pubIds.has(topic)) return
    this.pubIds.set(topic, this.uid++)
    this.pubTypes.set(topic, 'raw')
    if (this.connected) this.sendPublish(topic)
  }

  /** Subscribes to a raw topic; the handler gets every update (no dropping, 1 ms server-side period). */
  subscribeRaw(topic: string, handler: Handler): void {
    this.subs.set(topic, handler)
    if (this.connected) this.sendSubscribe(topic)
  }

  subscribeString(topic: string, handler: (v: string) => void): void {
    this.strHandlers.set(topic, handler)
    if (this.connected) this.sendSubscribe(topic)
  }

  setRaw(topic: string, bytes: Uint8Array): void {
    const id = this.pubIds.get(topic)
    if (id === undefined || !this.connected) return
    this.ws!.send(encode([id, 0, TYPE_RAW, bytes]))
  }

  private open(): void {
    let ws: WebSocket
    try { ws = new WebSocket(`ws://${this.host}:${this.port}/nt/${this.clientName}`, PROTOCOL) } catch { this.retry(); return }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.idToName.clear()
      for (const t of this.pubIds.keys()) this.sendPublish(t)
      for (const t of this.subs.keys()) this.sendSubscribe(t)
      for (const t of this.strHandlers.keys()) this.sendSubscribe(t)
      this.onConnection(true)
    }
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onText(ev.data) : this.onBinary(new Uint8Array(ev.data as ArrayBuffer)))
    ws.onclose = () => { this.onConnection(false); if (!this.stopped) this.retry() }
    ws.onerror = () => { /* onclose follows */ }
  }

  private retry(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.open(), 500)
  }

  private json(method: string, params: unknown): void { this.ws!.send(JSON.stringify([{ method, params }])) }

  private sendPublish(topic: string): void {
    this.json('publish', { name: topic, type: this.pubTypes.get(topic) ?? 'raw', pubuid: this.pubIds.get(topic), properties: {} })
  }

  private sendSubscribe(topic: string): void {
    this.json('subscribe', { topics: [topic], subuid: this.uid++, options: { all: true, periodic: 0.001 } })
  }

  private onText(text: string): void {
    for (const m of JSON.parse(text) as { method: string; params: { id: number; name: string } }[]) {
      if (m.method === 'announce') this.idToName.set(m.params.id, m.params.name)
      else if (m.method === 'unannounce') this.idToName.delete(m.params.id)
    }
  }

  private onBinary(bytes: Uint8Array): void {
    for (const msg of decodeMulti(bytes)) {
      const [id, , type, value] = msg as [number, number, number, unknown]
      if (id < 0) continue
      const name = this.idToName.get(id)
      if (!name) continue
      if (type === TYPE_RAW && value instanceof Uint8Array) this.subs.get(name)?.(value)
      else if (type === TYPE_STRING && typeof value === 'string') this.strHandlers.get(name)?.(value)
    }
  }
}
