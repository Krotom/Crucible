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
    child.on('exit', (code) => {
      this.child = null
      // a last line without a newline (a crash message, "BUILD FAILED") is still waiting in `tail`: report it before the exit.
      // 'close' follows once the pipes are drained; a grandchild that holds them open must not keep the app waiting, so give up after a moment.
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (tail.trim()) this.opts.onLog(tail)
        tail = ''
        this.opts.onExit(code)
      }
      const timer = setTimeout(finish, 300)
      child.once('close', finish)
    })
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
export function resolveRobotDir(appRoot: string, configDirs: string[] = []): string | null {
  const candidates: string[] = []
  // crucible.config.json next to the app, then in the user's settings folder (where the installer writes it): { "robotDir": "C:/path/to/robot-project" }
  // the folders the user chose in the app (settings folder) win over the app folder's file
  for (const dir of [...configDirs, appRoot]) {
    const cfg = path.join(dir, 'crucible.config.json')
    if (fs.existsSync(cfg)) {
      try { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j.robotDir) candidates.push(path.resolve(dir, j.robotDir)) } catch { /* ignore */ }
    }
  }
  candidates.push(path.resolve(appRoot, '../../OffSeasonCode/OffSeasonCode'))
  return candidates.find((c) => fs.existsSync(path.join(c, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) ?? null
}

/** The command that runs the robot sim with the Crucible bridge on. --no-daemon keeps the whole thing in one process tree. */
export function simulateCommand(lockstep = false, extraEnv: Record<string, string> = {}): { command: string; args: string[]; env: Record<string, string> } {
  // lockstep (Mode B): the robot's clock and Talon/swerve emulation run under the app's control (docs/NT_CONTRACT.md section 14).
  // The variables the bridge needs are set last, so extra variables can never switch it off.
  const env: Record<string, string> = { ...extraEnv, CRUCIBLE_BRIDGE: '1', ...(lockstep ? { CRUCIBLE_MODE: 'lockstep' } : {}) }
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', '.\\gradlew.bat', 'simulateJava', '--no-daemon', '--console=plain'], env }
    : { command: './gradlew', args: ['simulateJava', '--no-daemon', '--console=plain'], env }
}

// ---------------------------------------------------------------- project choice, environment, sources

const CONFIG_NAME = 'crucible.config.json'

export function readConfig(dir: string): Record<string, unknown> {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8')) as unknown; return j && typeof j === 'object' ? (j as Record<string, unknown>) : {} } catch { return {} }
}

export function writeConfig(dir: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify({ ...readConfig(dir), ...patch }, null, 2))
}

export const hasGradlew = (dir: string): boolean => fs.existsSync(path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))

/** Remembers a robot project folder the user picked (in the user's settings folder, which wins over the app folder): checks it has gradlew, keeps the last five. */
export function chooseRobotDir(userData: string, dir: string): { ok: true; dir: string } | { ok: false; error: string } {
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, error: `${abs} is not a folder` }
  if (!hasGradlew(abs)) return { ok: false, error: `no ${process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'} in ${abs}: pick the robot project folder (the one with build.gradle)` }
  const recent = [abs, ...recentRobotDirs(userData).filter((d) => d !== abs)].slice(0, 5)
  writeConfig(userData, { robotDir: abs, recentDirs: recent })
  return { ok: true, dir: abs }
}

export function recentRobotDirs(userData: string): string[] {
  const r = readConfig(userData).recentDirs
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

/** KEY=VALUE lines (blank lines and # comments skipped) into an environment, and what was wrong with the lines that were not usable. */
export function parseEnvText(text: string): { env: Record<string, string>; problems: string[] } {
  const env: Record<string, string> = {}
  const problems: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const eq = line.indexOf('=')
    const key = eq < 0 ? line : line.slice(0, eq).trim()
    if (eq < 0) { problems.push(`line ${i + 1}: "${line}" has no "="`); return }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { problems.push(`line ${i + 1}: "${key}" is not a valid variable name`); return }
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    env[key] = value
  })
  return { env, problems }
}

const SKIP_DIRS = new Set(['build', '.gradle', 'node_modules', '.git', 'bin', 'out'])

/** Finds `File.java` under the project's src folder (the stack trace only gives the file name): the first match, shallowest first. */
export function findSourceFile(robotDir: string, fileName: string, maxFiles = 20000): string | null {
  if (!/^[\w$.-]+\.(java|kt)$/.test(fileName)) return null
  const queue: string[] = [path.join(robotDir, 'src')]
  let seen = 0
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    const subdirs: string[] = []
    for (const e of entries) {
      if (++seen > maxFiles) return null
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) subdirs.push(path.join(dir, e.name)) }
      else if (e.name === fileName) return path.join(dir, e.name)
    }
    queue.push(...subdirs)
  }
  return null
}

export interface EditorDeps {
  spawnEditor: (commandLine: string) => Promise<boolean>
  openPath: (file: string) => Promise<string>
}

/** Opens a source file at a line: with the `editor` command from the config ("code --goto {file}:{line}") or VS Code when it is installed, else with the system's default app. */
export async function openInEditor(file: string, line: number, cfg: Record<string, unknown>, deps: EditorDeps): Promise<{ ok: boolean; how: string }> {
  const quoted = `"${file.replace(/"/g, '')}"`
  const template = typeof cfg.editor === 'string' && cfg.editor.trim() !== '' ? cfg.editor : 'code --goto {file}:{line}'
  const cmd = template.replace(/\{file\}/g, quoted).replace(/\{line\}/g, String(Math.max(1, Math.floor(line))))
  if (await deps.spawnEditor(cmd)) return { ok: true, how: 'editor' }
  const err = await deps.openPath(file)
  return err === '' ? { ok: true, how: 'default app' } : { ok: false, how: err }
}
