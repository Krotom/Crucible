// Who holds the ports the robot simulation needs. A robot simulation that outlived its app (the app was killed, a second copy was started from an
// IDE, a crashed run) keeps its ports, and the next start then fails inside the robot with "Address already in use". The pre-flight check asks here
// first, so the message names the holder, and the Robot tab can stop it. Plain Node (no Electron), so it can be tested with fake command output.
import { execFile } from 'node:child_process'

export interface PortOwner { port: number; pid: number; name: string }

/** The ports the robot sim opens: the bridge (5811) and the NetworkTables servers (5810, 1735). The camera ports (1181...) only log an error and are left out. */
export const ROBOT_PORTS = [5811, 5810, 1735]

/** `netstat -ano -p TCP` into the listening sockets on the wanted ports. A listening row has a foreign address ending in :0, which holds in every language
 *  (the word for the state does not: "LISTENING" is "DİNLENİYOR" on a Turkish Windows). */
export function parseNetstat(text: string, ports: number[]): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const c = raw.trim().split(/\s+/)
    if (c.length < 4 || !/^TCP/i.test(c[0])) continue
    const local = /:(\d+)$/.exec(c[1])
    const foreign = /:(\d+)$/.exec(c[2])
    const pid = Number(c[c.length - 1])
    if (!local || !foreign || Number(foreign[1]) !== 0 || !Number.isInteger(pid) || pid <= 0) continue
    const port = Number(local[1])
    if (ports.includes(port) && !out.some((o) => o.port === port && o.pid === pid)) out.push({ port, pid })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS, Linux) into the listening sockets on the wanted ports. */
export function parseLsof(text: string, ports: number[]): { port: number; pid: number; name: string }[] {
  const out: { port: number; pid: number; name: string }[] = []
  let pid = 0
  let name = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); name = '' } else if (line.startsWith('c')) name = line.slice(1)
    else if (line.startsWith('n')) {
      const m = /:(\d+)$/.exec(line.slice(1))
      if (m && ports.includes(Number(m[1])) && pid > 0 && !out.some((o) => o.port === Number(m[1]) && o.pid === pid)) out.push({ port: Number(m[1]), pid, name })
    }
  }
  return out
}

/** The first field of `tasklist /FO CSV /NH` output: "java.exe","8020",... */
export function parseTasklistName(text: string): string {
  const m = /^"([^"]+)"/m.exec(text)
  return m ? m[1] : ''
}

/** A Java process: the robot simulation runs as one (Gradle starts it), and only that is stopped from the app. */
export const isRobotSim = (name: string): boolean => /^javaw?(\.exe)?$/i.test(name.trim())

export type Run = (cmd: string, args: string[]) => Promise<string>

const defaultRun: Run = (cmd, args) => new Promise((resolve) => {
  try { execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 4_000_000, encoding: 'utf8' }, (_e, stdout) => resolve(String(stdout ?? ''))) } catch { resolve('') }
})

/** The processes listening on `ports` right now. Empty when it cannot be asked (a missing command is not a reason to block a launch). */
export async function portOwners(ports: number[] = ROBOT_PORTS, run: Run = defaultRun, platform: string = process.platform): Promise<PortOwner[]> {
  if (platform === 'win32') {
    const hits = parseNetstat(await run('netstat', ['-ano', '-p', 'TCP']), ports)
    const names = new Map<number, string>()
    for (const pid of new Set(hits.map((h) => h.pid))) names.set(pid, parseTasklistName(await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])))
    return hits.map((h) => ({ ...h, name: names.get(h.pid) || 'unknown' })).sort((a, b) => a.port - b.port)
  }
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  return parseLsof(out, ports).sort((a, b) => a.port - b.port)
}

export type Kill = (pid: number) => Promise<void>

const defaultKill: Kill = async (pid) => {
  if (process.platform === 'win32') await defaultRun('taskkill', ['/PID', String(pid), '/T', '/F'])
  else { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
}

/** Short text for a list of holders, for messages: "java.exe (PID 8020) on 5811, 5810". */
export function describeOwners(owners: PortOwner[]): string {
  const byPid = new Map<number, PortOwner[]>()
  for (const o of owners) byPid.set(o.pid, [...(byPid.get(o.pid) ?? []), o])
  return [...byPid.entries()].map(([pid, list]) => `${list[0].name} (PID ${pid}) on ${list.map((o) => o.port).join(', ')}`).join('; ')
}

/** Stops the Java processes that hold the robot's ports (with the processes they started) and says what it did. Anything that is not Java is left alone
 *  and reported: it is some other program, and the user decides about it. The holders are looked up again here, never taken from the caller. */
export async function freeRobotPorts(ports: number[] = ROBOT_PORTS, run: Run = defaultRun, kill: Kill = defaultKill, platform: string = process.platform): Promise<{ stopped: PortOwner[]; skipped: PortOwner[]; still: PortOwner[] }> {
  const owners = await portOwners(ports, run, platform)
  const stopped: PortOwner[] = []
  const skipped: PortOwner[] = []
  const done = new Set<number>()
  for (const o of owners) {
    if (!isRobotSim(o.name)) { skipped.push(o); continue }
    stopped.push(o)
    if (!done.has(o.pid)) { done.add(o.pid); await kill(o.pid) }
  }
  // the OS takes a moment to release a socket: look again until the stopped holders are gone (or give up after about 3 s)
  let still: PortOwner[] = []
  for (let i = 0; i < 10; i++) {
    still = (await portOwners(ports, run, platform)).filter((o) => done.has(o.pid))
    if (still.length === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  return { stopped, skipped, still }
}
