import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveRobotDir, RobotLauncher, simulateCommand } from './robot'
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

ipcMain.handle('robot:start', (_e, lockstep?: boolean) => {
  if (launcher?.running) return { ok: true, message: 'already running' }
  const dir = resolveRobotDir(app.getAppPath(), [app.getPath('userData')])
  if (!dir) return { ok: false, message: 'Robot project not found (set robotDir in app/crucible.config.json)' }
  const { command, args, env } = simulateCommand(lockstep === true)
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

// screenshots and videos: the renderer hands over the bytes, the user picks where they go (Pictures for PNG, Videos for WebM)
ipcMain.handle('file:save', async (_e, name: string, data: ArrayBuffer, kind: 'png' | 'webm') => {
  const dir = app.getPath(kind === 'png' ? 'pictures' : 'videos')
  const r = await dialog.showSaveDialog(win!, { defaultPath: join(dir, name), filters: kind === 'png' ? [{ name: 'PNG image', extensions: ['png'] }] : [{ name: 'WebM video', extensions: ['webm'] }] })
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
app.on('before-quit', () => { void launcher?.stop(); staticServer?.close() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
