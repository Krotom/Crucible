// The sim bridge channel: a local WebSocket to the robot (frc/robot/lib/simbridge/WsServer.java). Every message is one byte
// of type followed by the frame. NetworkTables is too slow for this exchange (it batches updates in tens of milliseconds),
// so NT only carries what people look at.
export const MSG_TO_APP = 1 // robot to app
export const MSG_FROM_APP = 2 // app to robot
export const MSG_DS = 3
export const MSG_JOYSTICK = 4
export const MSG_POSE_SEED = 5
export const MSG_HELLO = 6 // robot to app, UTF-8 JSON
export const MSG_STATS = 7 // robot to app: f64 average round trip us, f64 max round trip us, i64 stale ticks

export const DEFAULT_WS_PORT = 5811

export class WsTransport {
  private ws: WebSocket | null = null
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  onMessage: (type: number, body: Uint8Array) => void = () => {}
  onConnection: (connected: boolean) => void = () => {}

  constructor(private host: string, private port: number) {}

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  start(): void { this.stopped = false; this.open() }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  send(type: number, body: Uint8Array): void {
    if (!this.connected) return
    const m = new Uint8Array(body.length + 1)
    m[0] = type
    m.set(body, 1)
    this.ws!.send(m)
  }

  private open(): void {
    let ws: WebSocket
    try { ws = new WebSocket(`ws://${this.host}:${this.port}`) } catch { this.retry(); return }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => this.onConnection(true)
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data as ArrayBuffer)
      if (b.length > 0) this.onMessage(b[0], b.subarray(1))
    }
    ws.onclose = () => { this.onConnection(false); if (!this.stopped) this.retry() }
    ws.onerror = () => { /* onclose follows */ }
  }

  private retry(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.open(), 500)
  }
}
