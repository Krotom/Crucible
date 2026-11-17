// The renderer's only door to the main process: starting and stopping the robot simulation.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('crucibleHost', {
  startRobot: (lockstep?: boolean): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('robot:start', lockstep),
  saveFile: (name: string, data: ArrayBuffer, kind: 'png' | 'webm'): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('file:save', name, data, kind),
  stopRobot: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('robot:stop'),
  robotStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('robot:status'),
  onRobotLog: (cb: (line: string) => void): void => { ipcRenderer.on('robot:log', (_e, line: string) => cb(line)) },
  onRobotExit: (cb: (code: number | null) => void): void => { ipcRenderer.on('robot:exit', (_e, code: number | null) => cb(code)) },
})
