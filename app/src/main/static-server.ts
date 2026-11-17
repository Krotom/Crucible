// The built app is served to its own window from a tiny HTTP server on 127.0.0.1 (a random free port): the page, its worker and the robot model
// (the AdvantageScope-layout folder, found as described in tools/model-plugin.ts, which does the same job for the dev server) then load the
// same way in the packaged app as in development. Nothing leaves the machine: the server only listens on the loopback address.
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.map': 'application/json',
}

export function resolveModelDir(appRoot: string, configDirs: string[] = []): string | null {
  const candidates: string[] = []
  if (process.env.CRUCIBLE_MODEL_DIR) candidates.push(process.env.CRUCIBLE_MODEL_DIR)
  for (const dir of [appRoot, ...configDirs]) {
    const cfg = path.join(dir, 'crucible.config.json')
    if (fs.existsSync(cfg)) {
      try { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j.modelDir) candidates.push(path.resolve(dir, j.modelDir)) } catch { /* ignore */ }
    }
  }
  candidates.push(path.resolve(appRoot, '../../OffSeasonCode/OffSeasonCode/advantagescope/Robot_OffSeason'))
  return candidates.find((c) => fs.existsSync(path.join(c, 'config.json'))) ?? null
}

function safeFile(root: string, rel: string): string | null {
  const file = path.resolve(root, rel)
  if (file !== root && !file.startsWith(root + path.sep)) return null // never outside the folder
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null
}

/** Starts the server; resolves with its base URL. */
export function startStaticServer(rendererDir: string, appRoot: string, configDirs: string[] = []): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
    let file: string | null = null
    if (pathname.startsWith('/model/')) {
      const dir = resolveModelDir(appRoot, configDirs)
      file = dir ? safeFile(dir, pathname.slice('/model/'.length)) : null
    } else {
      file = safeFile(rendererDir, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''))
    }
    if (!file) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() }))
  })
}
