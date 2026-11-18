// Recently opened files: a small list in the user-data folder, newest first. Files that were deleted drop out when the list is read.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const MAX = 8
const ALLOWED = new Set(['.wpilog', '.json', '.csv'])

export interface RecentFile { path: string; name: string }

export class RecentFiles {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'recent-files.json') }

  private async load(): Promise<string[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
    } catch { return [] }
  }

  async list(): Promise<RecentFile[]> {
    const all = await this.load()
    return all.filter((p) => existsSync(p)).slice(0, MAX).map((p) => ({ path: p, name: basename(p) }))
  }

  /** Puts a file at the top. Only kinds the app opens are remembered. Returns false when the path is refused. */
  async add(path: string): Promise<boolean> {
    if (typeof path !== 'string' || !path || !ALLOWED.has(extname(path).toLowerCase())) return false
    const rest = (await this.load()).filter((p) => p !== path)
    try { await writeFile(this.file, JSON.stringify([path, ...rest].slice(0, 20))); return true } catch { return false }
  }

  async forget(path: string): Promise<void> {
    const rest = (await this.load()).filter((p) => p !== path)
    try { await writeFile(this.file, JSON.stringify(rest)) } catch { /* nothing to do */ }
  }

  /** The bytes of a remembered file. Only a path that is in the list can be read: the page cannot use this to read other files. */
  async read(path: string): Promise<{ name: string; data: Buffer } | null> {
    if (!(await this.load()).includes(path)) return null
    try { return { name: basename(path), data: await readFile(path) } } catch { return null }
  }
}
