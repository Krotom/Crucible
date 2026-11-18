// Files the app writes into the team's robot project, so a report can be committed next to the code it is about: <project>/crucible/reports/<name>.
// The page only supplies a name and bytes; the folder is fixed and the name cannot climb out of it.
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const ALLOWED = new Set(['.html', '.json', '.csv', '.txt'])
export const REPORT_DIR = ['crucible', 'reports']

/** A safe file name from what the page sent: no folders, no odd characters, a known extension. Null when there is nothing usable. */
export function safeReportName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const base = basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  if (!base || base.length > 120 || !ALLOWED.has(extname(base).toLowerCase())) return null
  return base
}

export async function writeProjectReport(projectDir: string | null, name: unknown, data: Uint8Array | ArrayBuffer): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!projectDir) return { ok: false, error: 'No robot project is chosen: pick one in the Robot tab first' }
  const safe = safeReportName(name)
  if (!safe) return { ok: false, error: 'That file name cannot be used (html, json, csv or txt only)' }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength > 32 * 1024 * 1024) return { ok: false, error: 'The file is too large (over 32 MB)' }
  try {
    const dir = join(projectDir, ...REPORT_DIR)
    await mkdir(dir, { recursive: true })
    const path = join(dir, safe)
    await writeFile(path, bytes)
    return { ok: true, path }
  } catch (e) { return { ok: false, error: `Could not write it: ${(e as Error).message}` } }
}
