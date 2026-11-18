// The renderer's only door to the main process: starting and stopping the robot simulation.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('crucibleHost', {
  startRobot: (lockstep?: boolean, envText?: string): Promise<unknown> => ipcRenderer.invoke('robot:start', lockstep, envText),
  checkRobot: (lockstep?: boolean): Promise<unknown> => ipcRenderer.invoke('robot:check', lockstep),
  getRobotDir: (): Promise<{ dir: string | null; recent: string[] }> => ipcRenderer.invoke('robot:getDir'),
  setRobotDir: (dir: string): Promise<unknown> => ipcRenderer.invoke('robot:setDir', dir),
  pickRobotDir: (): Promise<unknown> => ipcRenderer.invoke('robot:pickDir'),
  openSource: (file: string, line: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('robot:openSource', file, line),
  listLogs: (): Promise<{ name: string; size: number; mtime: number }[]> => ipcRenderer.invoke('log:list'),
  readLog: (name: string): Promise<string | null> => ipcRenderer.invoke('log:read', name),
  saveFile: (name: string, data: ArrayBuffer, kind: string): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('file:save', name, data, kind),
  stopRobot: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('robot:stop'),
  robotStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('robot:status'),
  onRobotLog: (cb: (line: string) => void): void => { ipcRenderer.on('robot:log', (_e, line: string) => cb(line)) },
  onRobotExit: (cb: (code: number | null) => void): void => { ipcRenderer.on('robot:exit', (_e, code: number | null) => cb(code)) },
})
