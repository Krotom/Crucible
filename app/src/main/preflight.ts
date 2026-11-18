// Checks of the robot project before it is launched: is there a gradlew, a Java, the bridge library and its hook in the code, and for lockstep the
// emulation layer. Plain Node (no Electron) so it can be tested on temporary folders.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { hasGradlew } from './robot'
import { describeOwners, isRobotSim, type PortOwner } from './ports'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface Check { id: string; label: string; status: CheckStatus; detail: string }

const SKIP = new Set(['build', '.gradle', 'node_modules', '.git', 'bin', 'out'])

/** Files under `root` (depth-limited, shallowest first) that pass `want`. */
function walk(root: string, want: (name: string) => boolean, maxFiles = 4000): string[] {
  const found: string[] = []
  const queue = [root]
  let seen = 0
  while (queue.length > 0 && seen < maxFiles) {
    const dir = queue.shift()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      seen++
      if (e.isDirectory()) { if (!SKIP.has(e.name)) queue.push(path.join(dir, e.name)) }
      else if (want(e.name)) found.push(path.join(dir, e.name))
    }
  }
  return found
}

function readSmall(file: string): string {
  try { const st = fs.statSync(file); return st.size > 400_000 ? '' : fs.readFileSync(file, 'utf8') } catch { return '' }
}

/** Asks `java -version`; resolves to the version line, or null when there is no Java on the path. */
export function javaVersion(timeoutMs = 6000, command = 'java'): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    let child
    try { child = spawn(command, ['-version'], { windowsHide: true }) } catch { return resolve(null) }
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d }) // java prints its version on stderr
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 || out.includes('version') ? (out.split(/\r?\n/).find((l) => /version/i.test(l)) ?? out.trim()) || null : null))
  })
}

export interface PreflightExtra {
  /** who holds the robot's ports right now (leave out to skip the check, e.g. while the app's own robot is running) */
  ports?: () => Promise<PortOwner[]>
  /** where the Java comes from, for the message */
  javaFrom?: 'config' | 'wpilib' | 'path'
}

export async function preflight(dir: string | null, lockstep: boolean, java: () => Promise<string | null> = javaVersion, extra: PreflightExtra = {}): Promise<Check[]> {
  const checks: Check[] = []
  if (!dir) {
    checks.push({ id: 'project', label: 'Robot project', status: 'fail', detail: 'not found: choose the folder with the Choose… button (or set robotDir in crucible.config.json)' })
    return checks
  }
  checks.push({ id: 'project', label: 'Robot project', status: hasGradlew(dir) ? 'ok' : 'fail', detail: hasGradlew(dir) ? dir : `no gradlew in ${dir}` })
  const v = await java()
  const via = extra.javaFrom === 'wpilib' ? ' (WPILib\'s own JDK)' : extra.javaFrom === 'config' ? ' (javaHome in crucible.config.json)' : ''
  checks.push(v ? { id: 'java', label: 'Java', status: 'ok', detail: `${v}${via}` } : { id: 'java', label: 'Java', status: 'fail', detail: extra.javaFrom === 'config' ? 'javaHome in crucible.config.json does not hold a working java' : 'java was not found: Gradle needs it (install WPILib, which brings its own JDK, or put a JDK on the PATH)' })

  // the ports the robot sim opens: a robot sim that is still running from an earlier start holds them and the new one cannot listen
  if (extra.ports) {
    const owners = await extra.ports()
    if (owners.length > 0) {
      const sim = owners.every((o) => isRobotSim(o.name))
      checks.push({
        id: 'ports', label: 'Robot ports', status: 'fail',
        detail: sim
          ? `${describeOwners(owners)} still holds the robot's ports: a robot simulation from an earlier start is still running. Use "Stop the old robot" (Robot tab), or close it yourself, then start again`
          : `${describeOwners(owners)} holds the robot's ports: close that program (it is not a robot simulation), then start again`,
      })
    } else checks.push({ id: 'ports', label: 'Robot ports', status: 'ok', detail: 'free' })
  }

  const src = path.join(dir, 'src')
  const bridge = walk(src, (n) => n === 'SimBridge.java')
  checks.push(bridge.length ? { id: 'lib', label: 'Bridge library', status: 'ok', detail: path.relative(dir, bridge[0]) } : { id: 'lib', label: 'Bridge library', status: 'fail', detail: 'SimBridge.java is not in the project: use "Patch a robot project" (or npm run integrate-robot) first' })

  let hooked = false
  for (const f of walk(src, (n) => n.endsWith('.java') && n !== 'SimBridge.java').slice(0, 400)) {
    if (/SimBridge\.isEnabled\s*\(/.test(readSmall(f))) { hooked = true; break }
  }
  checks.push(hooked ? { id: 'hook', label: 'Bridge hook in the robot code', status: 'ok', detail: 'SimBridge.isEnabled() is called' } : { id: 'hook', label: 'Bridge hook in the robot code', status: bridge.length ? 'fail' : 'warn', detail: 'no call to SimBridge.isEnabled() found: the robot program would not talk to the app' })

  const gradle = ['build.gradle', 'build.gradle.kts'].map((n) => readSmall(path.join(dir, n))).join('\n')
  const guarded = /CRUCIBLE_BRIDGE/.test(gradle)
  const guiOn = /addGui\(\)\.defaultEnabled\s*=\s*true/.test(gradle)
  checks.push(guarded ? { id: 'gui', label: 'Simulation GUI', status: 'ok', detail: 'build.gradle keeps it off while the bridge is on' } : { id: 'gui', label: 'Simulation GUI', status: guiOn ? 'warn' : 'ok', detail: guiOn ? 'build.gradle turns the simulation GUI on: it would overwrite the app joystick data (see docs/ROBOT_INTEGRATION.md)' : 'no simulation GUI configured' })

  if (lockstep) {
    const emu = walk(src, (n) => n === 'EmuSwerve.java' || n === 'EmuTalon.java')
    const names = new Set(emu.map((f) => path.basename(f)))
    checks.push(names.has('EmuSwerve.java') && names.has('EmuTalon.java') ? { id: 'lockstep', label: 'Lockstep layer', status: 'ok', detail: 'EmuTalon and EmuSwerve are in the project' } : { id: 'lockstep', label: 'Lockstep layer', status: 'fail', detail: 'EmuTalon.java / EmuSwerve.java are missing: lockstep (Mode B) needs the emulation layer (see docs/ROBOT_INTEGRATION.md)' })
  }
  return checks
}

export const preflightBlocks = (checks: Check[]): boolean => checks.some((c) => c.status === 'fail' && (c.id === 'project' || c.id === 'java' || c.id === 'ports'))
