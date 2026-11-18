import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listLogs, readLog, RunLog } from './logstore'
import { javaVersion, preflight, preflightBlocks } from './preflight'
import { chooseJava } from './javahome'
import { freeRobotPorts, portOwners, within } from './ports'
import { chooseRobotDir, findSourceFile, openInEditor, parseEnvText, readConfig, recentRobotDirs, resolveRobotDir, RobotLauncher, simulateCommand } from './robot'
import { startStaticServer } from './static-server'
import { RecentFiles } from './recent'
import { checkForUpdate } from './update'
import { cannotSelfUpdate, cleanStale, fetchAndVerify, installTarget, prepareSwap, startSwap } from './updater'
import { UPDATE_PUBLIC_KEY } from './update-key'
import type { UpdateResult } from '../renderer/src/lib/versions'
import { ApiServer, API_PORT, newToken, type ApiHandler } from './api'
import { writeProjectReport } from './projectfiles'
import { PLUGIN_FILE } from '../engine/plugin'

let win: BrowserWindow | null = null
let launcher: RobotLauncher | null = null

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

let staticServer: { url: string; close: () => void } | null = null

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    backgroundColor: '#0b0c0e',
    title: 'BALTA Crucible',
    icon: join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else {
    // the built app: its own page, worker and robot model come from a loopback-only server, as they do from the dev server
    staticServer ??= await startStaticServer(join(__dirname, '../renderer'), app.getAppPath(), [app.getPath('userData')], join(app.getPath('userData'), 'games'))
    await win.loadURL(staticServer.url)
  }
}

const userDir = (): string => app.getPath('userData')
const robotDir = (): string | null => resolveRobotDir(app.getAppPath(), [userDir()])
let runLog: RunLog | null = null
let starting = false // a start is in progress (the pre-flight check takes a moment): a second click must not start a second robot

ipcMain.handle('robot:start', async (_e, lockstep?: boolean, envText?: string) => {
  if (launcher?.running || starting) return { ok: true, message: 'already running', checks: [] }
  starting = true
  try { return await startRobot(lockstep, envText) } finally { starting = false }
})

async function startRobot(lockstep?: boolean, envText?: string): Promise<Record<string, unknown>> {
  const dir = robotDir()
  if (!dir) return { ok: false, message: 'Robot project not found (choose the folder with Choose… on the Robot tab, or set robotDir in crucible.config.json)', checks: [] }
  const java = chooseJava(readConfig(userDir()), dir)
  const checks = await robotPreflight(dir, lockstep === true)
  if (preflightBlocks(checks)) return { ok: false, message: checks.filter((c) => c.status === 'fail').map((c) => c.detail)[0] ?? 'cannot start', checks, portsBusy: checks.some((c) => c.id === 'ports' && c.status === 'fail') }
  // WPILib's own JDK (or the javaHome from crucible.config.json) runs Gradle; variables the user typed on the Robot tab still win
  const { command, args, env } = simulateCommand(lockstep === true, { ...(java.home ? { JAVA_HOME: java.home } : {}), ...parseEnvText(envText ?? '').env })
  const envProblems = parseEnvText(envText ?? '').problems
  await runLog?.close()
  runLog = new RunLog(join(userDir(), 'logs'))
  runLog.write(`# ${new Date().toISOString()}  ${lockstep ? 'lockstep' : 'real time'}  ${dir}`)
  const log = runLog
  launcher = new RobotLauncher({
    cwd: dir, command, args, env,
    onLog: (line) => { log.write(line); send('robot:log', line) },
    onExit: (code) => { log.write(`# exited with code ${code}`); void log.close(); send('robot:exit', code) },
  })
  launcher.start()
  return { ok: true, message: `starting robot sim in ${dir}`, checks, envProblems, logName: log.name }
}

/** The pre-flight check with this machine's Java choice and port look-up. While the app's own robot runs, its ports are its own: not a conflict. */
async function robotPreflight(dir: string | null, lockstep: boolean) {
  const java = chooseJava(readConfig(userDir()), dir)
  return preflight(dir, lockstep, () => javaVersion(6000, java.command), { javaFrom: java.source, ports: launcher?.running ? undefined : () => within(portOwners(), 2500, []) })
}

ipcMain.handle('robot:check', async (_e, lockstep?: boolean) => robotPreflight(robotDir(), lockstep === true))

// "Stop the old robot": a robot simulation that outlived its app holds the robot's ports. Only Java processes are stopped, and the holders are looked up here.
ipcMain.handle('robot:freePorts', async () => {
  if (launcher?.running) return { ok: false, message: 'The robot the app started is running: use Stop robot', stopped: 0 }
  const r = await freeRobotPorts()
  const pids = new Set(r.stopped.map((o) => o.pid))
  const other = r.skipped.length > 0 ? ` Left alone (not a robot simulation): ${[...new Set(r.skipped.map((o) => `${o.name} PID ${o.pid}`))].join(', ')}.` : ''
  if (r.still.length > 0) return { ok: false, message: `Could not stop PID ${[...new Set(r.still.map((o) => o.pid))].join(', ')}: close it yourself.${other}`, stopped: pids.size }
  if (pids.size === 0) return { ok: r.skipped.length === 0, message: r.skipped.length === 0 ? 'The robot ports are free' : `Nothing to stop.${other}`, stopped: 0 }
  return { ok: r.skipped.length === 0, message: `Stopped the old robot (PID ${[...pids].join(', ')}).${other}`, stopped: pids.size }
})
ipcMain.handle('robot:getDir', () => ({ dir: robotDir(), recent: recentRobotDirs(userDir()) }))
ipcMain.handle('robot:setDir', (_e, dir: string) => chooseRobotDir(userDir(), dir))
ipcMain.handle('robot:pickDir', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose the robot project folder (the one with build.gradle)', properties: ['openDirectory'], defaultPath: robotDir() ?? undefined })
  if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true }
  return chooseRobotDir(userDir(), r.filePaths[0])
})

/** Starts an editor command line; true when it started and did not fail straight away (an editor window can keep running). */
function spawnEditor(commandLine: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean): void => { if (!settled) { settled = true; resolve(v) } }
    try {
      const child = spawn(commandLine, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => done(false))
      child.on('exit', (code) => done(code === 0))
      child.unref()
      setTimeout(() => done(true), 1500)
    } catch { done(false) }
  })
}

ipcMain.handle('robot:openSource', async (_e, fileName: string, line: number) => {
  const dir = robotDir()
  if (!dir) return { ok: false, message: 'no robot project' }
  const file = findSourceFile(dir, fileName)
  if (!file) return { ok: false, message: `${fileName} is not under ${join(dir, 'src')}` }
  const cfg = { ...readConfig(app.getAppPath()), ...readConfig(userDir()) }
  const r = await openInEditor(file, line, cfg, { spawnEditor, openPath: (f) => shell.openPath(f) })
  return { ok: r.ok, message: r.ok ? `opened ${fileName}:${line} (${r.how})` : `could not open ${file}: ${r.how}`, file }
})

ipcMain.handle('log:list', () => listLogs(join(userDir(), 'logs')))
ipcMain.handle('log:read', (_e, name: string) => readLog(join(userDir(), 'logs'), name))

ipcMain.handle('robot:stop', async () => { await launcher?.stop(); return { ok: true } })
ipcMain.handle('robot:status', () => ({ running: launcher?.running ?? false }))

// files the page saves (screenshots, videos, reports, logs): the renderer hands over the bytes, the user picks where they go
const SAVE_KINDS: Record<string, { folder: 'pictures' | 'videos' | 'documents'; filter: { name: string; extensions: string[] } }> = {
  png: { folder: 'pictures', filter: { name: 'PNG image', extensions: ['png'] } },
  webm: { folder: 'videos', filter: { name: 'WebM video', extensions: ['webm'] } },
  html: { folder: 'documents', filter: { name: 'HTML report', extensions: ['html'] } },
  csv: { folder: 'documents', filter: { name: 'CSV table', extensions: ['csv'] } },
  json: { folder: 'documents', filter: { name: 'JSON file', extensions: ['json'] } },
  txt: { folder: 'documents', filter: { name: 'Text file', extensions: ['txt'] } },
  wpilog: { folder: 'documents', filter: { name: 'WPILOG', extensions: ['wpilog'] } },
}
ipcMain.handle('file:save', async (_e, name: string, data: ArrayBuffer, kind: string) => {
  const k = SAVE_KINDS[kind] ?? SAVE_KINDS.txt
  const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath(k.folder), name), filters: [k.filter] })
  if (r.canceled || !r.filePath) return { ok: false }
  await writeFile(r.filePath, Buffer.from(data))
  return { ok: true, path: r.filePath }
})

const recent = new RecentFiles(userDir())
ipcMain.handle('recent:list', () => recent.list())
ipcMain.handle('recent:add', (_e, path: string) => recent.add(path))
ipcMain.handle('recent:forget', (_e, path: string) => recent.forget(path))
ipcMain.handle('recent:read', async (_e, path: string) => {
  const r = await recent.read(path)
  return r ? { name: r.name, data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) } : null
})
ipcMain.handle('app:info', () => ({ packaged: app.isPackaged, testUpdateUrl: !!process.env.CRUCIBLE_UPDATE_URL }))
let lastUpdate: UpdateResult | null = null
let installing = false
const selfUpdateReason = (): Promise<string | null> => cannotSelfUpdate({ packaged: app.isPackaged, platform: process.platform, execPath: process.execPath })
ipcMain.handle('app:checkUpdate', async () => {
  const r = await checkForUpdate(app.getVersion())
  lastUpdate = r
  const why = r.status === 'newer' ? await selfUpdateReason() : null
  return { ...r, canInstall: r.status === 'newer' && why === null, cannotInstall: why ?? undefined }
})
// installs the release the last check found (the page never supplies an address): download, check, then swap after the app has quit
ipcMain.handle('app:installUpdate', async () => {
  if (installing) return { ok: false, error: 'An update is already being installed' }
  const r = lastUpdate
  if (!r || r.status !== 'newer' || !r.assets || !r.latest) return { ok: false, error: 'Check for updates first' }
  const why = await selfUpdateReason()
  if (why) return { ok: false, error: why }
  installing = true
  try {
    const target = installTarget(process.platform, process.execPath)!
    const dir = join(userDir(), 'updates')
    const verified = await fetchAndVerify({ fetchFn: fetch, assets: r.assets, platform: process.platform, arch: process.arch, version: r.latest, dir, publicKey: UPDATE_PUBLIC_KEY, onProgress: (p) => send('update:progress', p) })
    send('update:progress', { stage: 'prepare', text: 'Preparing the update…' })
    const plan = await prepareSwap({ platform: process.platform, target, verified, pid: process.pid, tmpDir: dir })
    send('update:progress', { stage: 'restart', text: 'Restarting to finish the update…' })
    startSwap(plan)
    setTimeout(() => app.quit(), 600)
    return { ok: true }
  } catch (e) { installing = false; return { ok: false, error: (e as Error).message } }
})
ipcMain.handle('app:openExternal', async (_e, url: string) => { if (typeof url === 'string' && /^https:\/\//.test(url)) { await shell.openExternal(url); return true } return false })

// reports written into the robot project (<project>/crucible/reports), so they can be committed next to the code
ipcMain.handle('report:saveToProject', (_e, name: string, data: ArrayBuffer) => writeProjectReport(robotDir(), name, data))

// game plugins: .js files in <user data>/games (served to the simulation worker by the loopback server)
ipcMain.handle('games:list', async () => {
  try { return (await readdir(join(userDir(), 'games'))).filter((f) => PLUGIN_FILE.test(f)).sort().map((file) => ({ file })) } catch { return [] }
})
ipcMain.handle('games:folder', async () => { const dir = join(userDir(), 'games'); await mkdir(dir, { recursive: true }); await shell.openPath(dir); return dir })

// the local API (opt-in): the page answers the requests, since the simulation lives there
interface ApiConfig { enabled: boolean; token: string }
const apiConfigFile = (): string => join(userDir(), 'api.json')
async function loadApiConfig(): Promise<ApiConfig> {
  try { const j = JSON.parse(await readFile(apiConfigFile(), 'utf8')) as Partial<ApiConfig>; if (typeof j.token === 'string' && /^[0-9a-f]{48}$/.test(j.token)) return { enabled: j.enabled === true, token: j.token } } catch { /* first run */ }
  return { enabled: false, token: newToken() }
}
const saveApiConfig = (c: ApiConfig): Promise<void> => writeFile(apiConfigFile(), JSON.stringify(c)).catch(() => {})
let apiConfig: ApiConfig | null = null
let api: ApiServer | null = null
let apiError = ''
const apiWaiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
let apiSeq = 0
const apiHandler: ApiHandler = (command) => new Promise((ok, fail) => {
  if (!win || win.isDestroyed()) { fail(new Error('the app window is closed')); return }
  const id = ++apiSeq
  apiWaiting.set(id, { ok, fail })
  setTimeout(() => { if (apiWaiting.delete(id)) fail(new Error('timeout')) }, 7000)
  win.webContents.send('api:request', { id, command })
})
ipcMain.on('api:response', (_e, id: number, ok: boolean, payload: unknown) => { const w = apiWaiting.get(id); apiWaiting.delete(id); if (w) { if (ok) w.ok(payload); else w.fail(new Error(typeof payload === 'string' ? payload : 'failed')) } })
async function applyApi(): Promise<void> {
  apiConfig ??= await loadApiConfig()
  apiError = ''
  if (apiConfig.enabled && !api) { api = new ApiServer(apiConfig.token, apiHandler); try { await api.start(API_PORT) } catch (e) { apiError = `Port ${API_PORT} is not available (${(e as Error).message})`; api = null } }
  else if (!apiConfig.enabled && api) { await api.stop(); api = null }
}
const apiState = (): { enabled: boolean; listening: boolean; token: string; port: number; error: string } => ({ enabled: apiConfig?.enabled ?? false, listening: api?.listening ?? false, token: apiConfig?.token ?? '', port: API_PORT, error: apiError })
ipcMain.handle('api:get', async () => { apiConfig ??= await loadApiConfig(); return apiState() })
ipcMain.handle('api:set', async (_e, enabled: boolean) => { apiConfig ??= await loadApiConfig(); apiConfig.enabled = enabled === true; await applyApi(); if (!apiError) await saveApiConfig(apiConfig); else apiConfig.enabled = false; return apiState() })
ipcMain.handle('api:newToken', async () => { apiConfig ??= await loadApiConfig(); apiConfig.token = newToken(); await saveApiConfig(apiConfig); if (api) { await api.stop(); api = null; await applyApi() }; return apiState() })

app.setName('BALTA Crucible')
if (process.platform === 'win32') app.setAppUserModelId('com.balta.crucible')

// one window at a time: a second launch brings the first to the front (two copies would fight over the robot bridge port)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

app.whenReady().then(() => {
  if (!gotLock) return
  void createWindow()
  void applyApi() // an API that was left on starts with the app
  if (app.isPackaged) void cleanStale(installTarget(process.platform, process.execPath)) // the leftovers of an interrupted update
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})
// Leaving the app stops the robot program it started (and the Gradle and Java processes under it), so no robot simulation is left holding the robot's
// ports. The quit waits for that to finish (a few seconds at most); only a robot this app launched is touched.
let quitting = false
const closeServices = (): void => { void api?.stop(); void runLog?.close(); staticServer?.close() }
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  if (launcher?.running) {
    e.preventDefault()
    void launcher.stop().finally(() => { closeServices(); app.quit() })
  } else closeServices()
})
// every other way out (a signal, a crash, the last exit): a synchronous kill, because nothing can wait for a promise any more
process.on('exit', () => launcher?.killNow())
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { launcher?.killNow(); app.quit() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
