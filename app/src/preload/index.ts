// The renderer's only door to the main process: starting and stopping the robot simulation.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('crucibleHost', {
  startRobot: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('robot:start'),
  stopRobot: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('robot:stop'),
  robotStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('robot:status'),
  onRobotLog: (cb: (line: string) => void): void => { ipcRenderer.on('robot:log', (_e, line: string) => cb(line)) },
  onRobotExit: (cb: (code: number | null) => void): void => { ipcRenderer.on('robot:exit', (_e, code: number | null) => cb(code)) },
})
