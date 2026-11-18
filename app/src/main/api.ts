// The local API: an opt-in HTTP server on 127.0.0.1 that lets scripts and other tools read the simulation state and send it commands
// (start, stop, reset, play, pause, step, load a preset ...). Off by default. Every request needs the token shown in Preferences.
// The server never answers a browser page: a request with an Origin header or a foreign Host is refused, so a web page cannot drive the app.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const API_PORT = 5812
const MAX_BODY = 64 * 1024
const TIMEOUT_MS = 8000

export type ApiHandler = (command: { action: string; [k: string]: unknown }) => Promise<unknown>

export function newToken(): string { return randomBytes(24).toString('hex') }

function tokenOk(given: string | undefined, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given), b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class ApiServer {
  private server: http.Server | null = null
  constructor(private token: string, private handler: ApiHandler) {}

  get listening(): boolean { return this.server !== null }
  get port(): number | null { return this.server ? (this.server.address() as AddressInfo).port : null }

  start(port = API_PORT): Promise<number> {
    if (this.server) return Promise.resolve(this.port!)
    const server = http.createServer((req, res) => { void this.handle(req, res) })
    return new Promise((resolve, reject) => {
      server.once('error', (e) => { this.server = null; reject(e) })
      server.listen(port, '127.0.0.1', () => { this.server = server; resolve((server.address() as AddressInfo).port) })
    })
  }

  stop(): Promise<void> {
    const s = this.server
    this.server = null
    return new Promise((resolve) => { if (!s) { resolve(); return }; s.close(() => resolve()); s.closeAllConnections?.() })
  }

  private reply(res: http.ServerResponse, code: number, body: unknown): void {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = this.port
    const host = (req.headers.host ?? '').toLowerCase()
    // a web page (or a DNS-rebinding trick) can reach 127.0.0.1 too: only plain clients with the right Host and no Origin are served
    if (req.headers.origin !== undefined) return this.reply(res, 403, { error: 'browser requests are not allowed' })
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return this.reply(res, 403, { error: 'wrong Host header' })
    const auth = req.headers.authorization ?? ''
    if (!tokenOk(/^Bearer (.+)$/.exec(auth)?.[1], this.token)) return this.reply(res, 401, { error: 'missing or wrong token (Authorization: Bearer <token>)' })
    const url = (req.url ?? '/').split('?')[0]
    if (url === '/api/status' && req.method === 'GET') return this.run(res, { action: 'status' })
    if (url === '/api/command' && req.method === 'POST') {
      let size = 0
      const chunks: Buffer[] = []
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) return this.reply(res, 413, { error: 'body too large' }); chunks.push(c as Buffer) }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return this.reply(res, 400, { error: 'the body must be JSON, for example {"action":"reset"}' }) }
      const action = (body as { action?: unknown })?.action
      if (!body || typeof body !== 'object' || typeof action !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(action)) return this.reply(res, 400, { error: 'the body needs an "action" (letters, digits, dashes)' })
      return this.run(res, body as { action: string })
    }
    if (url === '/api/status' || url === '/api/command') return this.reply(res, 405, { error: 'wrong method' })
    return this.reply(res, 404, { error: 'unknown route: use GET /api/status or POST /api/command' })
  }

  private async run(res: http.ServerResponse, command: { action: string }): Promise<void> {
    try {
      const result = await Promise.race([this.handler(command), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))])
      this.reply(res, 200, { ok: true, result })
    } catch (e) {
      const m = (e as Error).message
      this.reply(res, m === 'timeout' ? 504 : 400, { ok: false, error: m === 'timeout' ? 'the app did not answer in time' : m })
    }
  }
}
