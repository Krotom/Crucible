// Starts BALTA Crucible as a desktop app: node scripts/launch.mjs   (npm run app)
// If the built app is missing or older than the sources it builds first (a few seconds), then starts Electron on the build. Problems are written to
// %LOCALAPPDATA%\BALTA Crucible\launch.log and the exit code is non-zero, so the shortcut's wrapper can tell the user.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logDir = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'BALTA Crucible')
const logFile = path.join(logDir, 'launch.log')
fs.mkdirSync(logDir, { recursive: true })
const log = (s) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`)

function newest(dir) {
  let t = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) t = Math.max(t, newest(p))
    else t = Math.max(t, fs.statSync(p).mtimeMs)
  }
  return t
}

function stale() {
  const built = path.join(root, 'out', 'main', 'index.js')
  if (!fs.existsSync(built) || !fs.existsSync(path.join(root, 'out', 'renderer', 'index.html'))) return true
  const builtAt = Math.min(fs.statSync(built).mtimeMs, fs.statSync(path.join(root, 'out', 'renderer', 'index.html')).mtimeMs)
  let src = 0
  for (const d of ['src', 'robots', 'build']) if (fs.existsSync(path.join(root, d))) src = Math.max(src, newest(path.join(root, d)))
  for (const f of ['package.json', 'electron.vite.config.ts']) src = Math.max(src, fs.statSync(path.join(root, f)).mtimeMs)
  return src > builtAt
}

try {
  if (process.argv.includes('--build') || stale()) {
    log('building')
    const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) { log(`build failed:\n${r.stdout}\n${r.stderr}`); process.exit(1) }
  }
  const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!fs.existsSync(electron)) { log('electron is not installed: run npm install in the app folder'); process.exit(1) }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron, ['.'], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  log(`started (pid ${child.pid})`)
} catch (e) {
  log(`failed: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
}
