import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { resolveRobotDir, RobotLauncher, simulateCommand } from './robot'

let win: BrowserWindow | null = null
let launcher: RobotLauncher | null = null

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    backgroundColor: '#101216',
    title: 'Crucible',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle('robot:start', () => {
  if (launcher?.running) return { ok: true, message: 'already running' }
  const dir = resolveRobotDir(app.getAppPath())
  if (!dir) return { ok: false, message: 'Robot project not found (set robotDir in app/crucible.config.json)' }
  const { command, args, env } = simulateCommand()
  launcher = new RobotLauncher({
    cwd: dir, command, args, env,
    onLog: (line) => send('robot:log', line),
    onExit: (code) => send('robot:exit', code),
  })
  launcher.start()
  return { ok: true, message: `starting robot sim in ${dir}` }
})

ipcMain.handle('robot:stop', async () => { await launcher?.stop(); return { ok: true } })
ipcMain.handle('robot:status', () => ({ running: launcher?.running ?? false }))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('before-quit', () => { void launcher?.stop() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
