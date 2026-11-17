// Serves the robot model folder (AdvantageScope layout: model.glb, model_N.glb, model_info.json, config.json) at /model/*.
// The folder is not copied into git (about 26 MB). Resolution order: CRUCIBLE_MODEL_DIR, crucible.config.json "modelDir",
// then the sibling robot repo.
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

const appRoot = path.resolve(__dirname, '..')

export function resolveModelDir(): string | null {
  const candidates: string[] = []
  if (process.env.CRUCIBLE_MODEL_DIR) candidates.push(process.env.CRUCIBLE_MODEL_DIR)
  const cfg = path.join(appRoot, 'crucible.config.json')
  if (fs.existsSync(cfg)) {
    try { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j.modelDir) candidates.push(path.resolve(appRoot, j.modelDir)) } catch { /* ignore */ }
  }
  candidates.push(path.resolve(appRoot, '../../OffSeasonCode/OffSeasonCode/advantagescope/Robot_OffSeason'))
  return candidates.find((c) => fs.existsSync(path.join(c, 'config.json'))) ?? null
}

const TYPES: Record<string, string> = { '.glb': 'model/gltf-binary', '.json': 'application/json' }

export function modelServer(): Plugin {
  return {
    name: 'crucible-model-server',
    configureServer(server) {
      // dev aid: serve one log (CRUCIBLE_SAMPLE_LOG) so the renderer can be checked in a plain browser
      server.middlewares.use('/dev-sample-log', (_req, res) => {
        const f = process.env.CRUCIBLE_SAMPLE_LOG
        if (!f || !fs.existsSync(f)) { res.statusCode = 404; res.end('set CRUCIBLE_SAMPLE_LOG'); return }
        res.setHeader('Content-Type', 'application/octet-stream')
        fs.createReadStream(f).pipe(res)
      })
      server.middlewares.use('/model', (req, res, next) => {
        const dir = resolveModelDir()
        if (!dir) { res.statusCode = 404; res.end('no model folder found'); return }
        const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
        const file = path.resolve(dir, name)
        if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}
