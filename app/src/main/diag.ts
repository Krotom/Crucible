// Memory diagnostics: with `--diag` (or CRUCIBLE_DIAG=1) the app writes a detailed line every few seconds to <user data>/logs/diag-<time>.jsonl:
// every process's memory (the GPU process and the page process are the ones that have grown), the system's free memory, and what the page says
// about itself and about what the user did (see renderer/src/lib/diag.ts). Read it afterwards, or while the app runs.
import { app, BrowserWindow } from 'electron'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export const diagWanted = (): boolean => process.argv.includes('--diag') || process.env['CRUCIBLE_DIAG'] === '1'

const EVERY_MS = 5000
const MB = 1 / 1024 // KB to MB (Electron reports process memory in KB)

export interface DiagHandle { file: string; stop: () => void }

export function startDiag(getWindow: () => BrowserWindow | null): DiagHandle {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `diag-${stamp}.jsonl`)
  const out: WriteStream = createWriteStream(file, { flags: 'a' })
  const t0 = Date.now()
  const line = (o: unknown): void => { out.write(JSON.stringify(o) + '\n') }
  let peak = { gpu: 0, renderer: 0 }

  void (async () => {
    let gpu: unknown = null
    try { gpu = await app.getGPUInfo('basic') } catch { /* not available */ }
    line({
      kind: 'header', time: new Date().toISOString(), app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform,
      argv: process.argv.slice(1), gpuFeatures: app.getGPUFeatureStatus(), gpu,
    })
  })()

  const tick = async (): Promise<void> => {
    const win = getWindow()
    const metrics = app.getAppMetrics().map((m) => ({
      pid: m.pid, type: m.type, name: m.name, cpu: +m.cpu.percentCPUUsage.toFixed(1),
      workingSetMB: Math.round(m.memory.workingSetSize * MB), peakMB: Math.round(m.memory.peakWorkingSetSize * MB), privateMB: Math.round((m.memory.privateBytes ?? 0) * MB),
    }))
    const total = metrics.reduce((a, m) => a + m.workingSetMB, 0)
    const gpuMB = metrics.filter((m) => m.type === 'GPU').reduce((a, m) => a + m.workingSetMB, 0)
    const rendMB = metrics.filter((m) => m.type === 'Tab').reduce((a, m) => a + m.workingSetMB, 0)
    const sys = process.getSystemMemoryInfo()
    let page: unknown = null
    if (win && !win.isDestroyed()) {
      try {
        page = await Promise.race([win.webContents.executeJavaScript('window.__diag ? window.__diag() : null', true), new Promise((r) => setTimeout(() => r({ timeout: true }), 3000))])
      } catch (e) { page = { error: (e as Error).message } }
    }
    line({
      kind: 'sample', t: Math.round((Date.now() - t0) / 1000), appMB: total, gpuProcessMB: gpuMB, pageProcessMB: rendMB,
      system: { freeMB: Math.round(sys.free * MB), totalMB: Math.round(sys.total * MB) }, processes: metrics, mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576), page,
    })
    // a mark when a process first passes a size worth knowing about
    for (const [k, v] of [['gpu', gpuMB], ['renderer', rendMB]] as const) {
      if (v > peak[k] + 500) { peak = { ...peak, [k]: v }; line({ kind: 'mark', t: Math.round((Date.now() - t0) / 1000), text: `${k} process passed ${Math.floor(v / 500) * 500} MB` }) }
    }
  }
  const timer = setInterval(() => { void tick() }, EVERY_MS)
  return { file, stop: () => { clearInterval(timer); out.end() } }
}
