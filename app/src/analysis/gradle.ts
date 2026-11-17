// Starts and stops the robot project (Gradle simulateJava in lockstep mode) for a batch run. Node only.
import net from 'node:net'
import { RobotLauncher, resolveRobotDir, simulateCommand } from '../main/robot'
import type { RobotProcess } from './runner'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Waits until nothing listens on the bridge port: a robot that was just stopped can hold it for a moment and would answer the next run. */
export async function portFree(port = 5811): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const busy = await new Promise<boolean>((res) => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); res(true) })
      s.once('error', () => res(false))
    })
    if (!busy) return
    await wait(100)
  }
  throw new Error(`port ${port} stays busy: another robot or Crucible window is running`)
}

export function gradleRobot(appRoot: string, onLog: (line: string) => void = () => {}): RobotProcess {
  let launcher: RobotLauncher | null = null
  return {
    async start(): Promise<void> {
      const dir = resolveRobotDir(appRoot)
      if (!dir) throw new Error('robot project not found (set robotDir in app/crucible.config.json)')
      await portFree()
      const c = simulateCommand(true)
      launcher = new RobotLauncher({ cwd: dir, command: c.command, args: c.args, env: c.env, onLog, onExit: () => {} })
      launcher.start()
    },
    async stop(): Promise<void> {
      await launcher?.stop()
      launcher = null
      await portFree()
    },
  }
}
