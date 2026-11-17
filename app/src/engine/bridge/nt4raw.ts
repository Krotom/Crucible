// Small NetworkTables 4 subscriber for raw topics. The bridge frames do not use it (they travel on the bridge WebSocket,
// see ws-transport.ts); it only listens for the robot's own logged component poses. Uses the global WebSocket (browser,
// worker, Node 22+) and reconnects by itself.
import { decodeMulti } from '@msgpack/msgpack'

const PROTOCOL = 'v4.1.networktables.first.wpi.edu'
const TYPE_RAW = 5

type Handler = (value: Uint8Array) => void

export class Nt4Raw {
  private ws: WebSocket | null = null
  private uid = 1
  private subs = new Map<string, Handler>() // topic -> handler
  private idToName = new Map<number, string>()
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private host: string, private port: number, private clientName = 'crucible-bridge') {}

  start(): void { this.stopped = false; this.open() }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  /** Subscribes to a raw topic; the handler gets every update. */
  subscribeRaw(topic: string, handler: Handler): void {
    this.subs.set(topic, handler)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(topic)
  }

  private open(): void {
    let ws: WebSocket
    try { ws = new WebSocket(`ws://${this.host}:${this.port}/nt/${this.clientName}`, PROTOCOL) } catch { this.retry(); return }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.idToName.clear()
      for (const t of this.subs.keys()) this.sendSubscribe(t)
    }
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onText(ev.data) : this.onBinary(new Uint8Array(ev.data as ArrayBuffer)))
    ws.onclose = () => { if (!this.stopped) this.retry() }
    ws.onerror = () => { /* onclose follows */ }
  }

  private retry(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.open(), 500)
  }

  private sendSubscribe(topic: string): void {
    this.ws!.send(JSON.stringify([{ method: 'subscribe', params: { topics: [topic], subuid: this.uid++, options: { all: true, periodic: 0.01 } } }]))
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
      if (name && type === TYPE_RAW && value instanceof Uint8Array) this.subs.get(name)?.(value)
    }
  }
}
