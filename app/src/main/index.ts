import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listLogs, readLog, RunLog } from './logstore'
import { preflight, preflightBlocks } from './preflight'
import { chooseRobotDir, findSourceFile, openInEditor, parseEnvText, readConfig, recentRobotDirs, resolveRobotDir, RobotLauncher, simulateCommand } from './robot'
import { startStaticServer } from './static-server'

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
    staticServer ??= await startStaticServer(join(__dirname, '../renderer'), app.getAppPath(), [app.getPath('userData')])
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
  const checks = await preflight(dir, lockstep === true)
  if (preflightBlocks(checks)) return { ok: false, message: checks.filter((c) => c.status === 'fail').map((c) => c.detail)[0] ?? 'cannot start', checks }
  const { command, args, env } = simulateCommand(lockstep === true, parseEnvText(envText ?? '').env)
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

ipcMain.handle('robot:check', async (_e, lockstep?: boolean) => preflight(robotDir(), lockstep === true))
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

app.setName('BALTA Crucible')
if (process.platform === 'win32') app.setAppUserModelId('com.balta.crucible')

// one window at a time: a second launch brings the first to the front (two copies would fight over the robot bridge port)
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

app.whenReady().then(() => {
  if (!gotLock) return
  void createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
})
app.on('before-quit', () => { void launcher?.stop(); void runLog?.close(); staticServer?.close() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
