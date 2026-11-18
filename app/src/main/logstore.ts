// Every robot run is also written to a file in the user's settings folder, so output survives the window being closed and past runs can be looked at.
import fs from 'node:fs'
import path from 'node:path'

const KEEP = 20

export interface LogInfo { name: string; size: number; mtime: number }

const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-').slice(0, 19)

export class RunLog {
  private stream: fs.WriteStream | null = null
  readonly name: string

  constructor(dir: string, now = new Date()) {
    fs.mkdirSync(dir, { recursive: true })
    prune(dir, KEEP - 1) // make room for the file about to be created
    this.name = `robot-${stamp(now)}.log`
    this.stream = fs.createWriteStream(path.join(dir, this.name), { flags: 'a' })
  }

  write(line: string): void { this.stream?.write(`${line}\n`) }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const s = this.stream
      this.stream = null
      if (!s) return resolve()
      s.end(() => resolve())
    })
  }
}

/** Past runs, newest first. */
export function listLogs(dir: string): LogInfo[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names
    .filter((n) => /^robot-[\w-]+\.log$/.test(n))
    .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, mtime: st.mtimeMs } })
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1))
}

/** The text of a past run (the name must be one of the log files: no path tricks), capped so a huge log cannot stall the page. */
export function readLog(dir: string, name: string, maxBytes = 2_000_000): string | null {
  if (!/^robot-[\w-]+\.log$/.test(name)) return null
  try {
    const file = path.join(dir, name)
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(size, maxBytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len) // the end of the file
      return (size > maxBytes ? '[…earlier output cut…]\n' : '') + buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

export function prune(dir: string, keep = KEEP): void {
  for (const l of listLogs(dir).slice(keep)) { try { fs.unlinkSync(path.join(dir, l.name)) } catch { /* in use or gone */ } }
}
