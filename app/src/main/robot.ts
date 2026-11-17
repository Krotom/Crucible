// Starts and stops the robot simulation process (a Gradle build running the robot project's simulateJava task) for the app.
// Plain Node: no Electron imports, so it can be tested with a fake command.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface LauncherOptions {
  /** Robot project folder (the one with gradlew). */
  cwd: string
  command: string
  args: string[]
  env?: Record<string, string>
  onLog: (line: string) => void
  onExit: (code: number | null) => void
}

export class RobotLauncher {
  private child: ChildProcess | null = null
  constructor(private opts: LauncherOptions) {}

  get running(): boolean { return this.child !== null }

  start(): void {
    if (this.child) return
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      windowsHide: true,
      detached: process.platform !== 'win32', // its own process group, so the whole tree can be signalled
    })
    this.child = child
    let tail = ''
    const feed = (b: Buffer): void => {
      tail += b.toString()
      const lines = tail.split(/\r?\n/)
      tail = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) this.opts.onLog(l)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (e) => this.opts.onLog(`launch failed: ${e.message}`))
    child.on('exit', (code) => { this.child = null; this.opts.onExit(code) })
  }

  /** Stops the process and everything it started. Resolves once it has exited (or after a few seconds). */
  stop(): Promise<void> {
    const child = this.child
    const pid = child?.pid
    if (!child || pid === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(done, 5000)
      child.once('exit', done)
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      else try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    })
  }
}

/** Finds the robot project: crucible.config.json "robotDir", else the sibling robot repo. */
export function resolveRobotDir(appRoot: string): string | null {
  const candidates: string[] = []
  const cfg = path.join(appRoot, 'crucible.config.json')
  if (fs.existsSync(cfg)) {
    try { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j.robotDir) candidates.push(path.resolve(appRoot, j.robotDir)) } catch { /* ignore */ }
  }
  candidates.push(path.resolve(appRoot, '../../OffSeasonCode/OffSeasonCode'))
  return candidates.find((c) => fs.existsSync(path.join(c, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) ?? null
}

/** The command that runs the robot sim with the Crucible bridge on. --no-daemon keeps the whole thing in one process tree. */
export function simulateCommand(lockstep = false): { command: string; args: string[]; env: Record<string, string> } {
  // lockstep (Mode B): the robot's clock and Talon/swerve emulation run under the app's control (docs/NT_CONTRACT.md section 14)
  const env: Record<string, string> = lockstep ? { CRUCIBLE_BRIDGE: '1', CRUCIBLE_MODE: 'lockstep' } : { CRUCIBLE_BRIDGE: '1' }
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', '.\\gradlew.bat', 'simulateJava', '--no-daemon', '--console=plain'], env }
    : { command: './gradlew', args: ['simulateJava', '--no-daemon', '--console=plain'], env }
}
