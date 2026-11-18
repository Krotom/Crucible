// A shareable run: one small JSON file with the set-up (game, seed, opponent, alliance, start, tune, battery, faults, vision, breakpoints) and the report of what happened.
// Opening it on another computer restores the set-up and loads the report as run A for comparing, so "here is the run where the shooter missed" can be sent in chat.
// What it cannot do: replay the driver. The keys or sticks are not recorded; scripted bots and the test scenarios are repeatable from the set-up alone.
import type { RunReport } from '../../../analysis/recorder'
import { parseRunReport } from './compare'
import type { Values } from './presets'

export const RUN_FORMAT = 'crucible-run'
export const RUN_VERSION = 1
const MAX_BYTES = 8 * 1024 * 1024

export interface RunFile {
  format: typeof RUN_FORMAT
  version: number
  created: string
  app: string
  /** who or what made it, free text ("practice 4, new hood") */
  note: string
  setup: Values
  report: RunReport
}

export function makeRunFile(setup: Values, report: RunReport, app: string, note = '', now = new Date()): RunFile {
  return { format: RUN_FORMAT, version: RUN_VERSION, created: now.toISOString(), app, note: note.slice(0, 300), setup: { ...setup }, report }
}

/** Reads a shared run (or a plain report.json, which has no set-up). Says what is wrong in words. */
export function parseRunFile(text: string): { ok: true; file: RunFile; hasSetup: boolean } | { ok: false; error: string } {
  if (text.length > MAX_BYTES) return { ok: false, error: 'the file is too large to be a run (over 8 MB)' }
  let j: unknown
  try { j = JSON.parse(text) } catch { return { ok: false, error: 'not valid JSON' } }
  if (!j || typeof j !== 'object') return { ok: false, error: 'not a run file' }
  const r = j as Record<string, unknown>
  if (r.format !== RUN_FORMAT) {
    const plain = parseRunReport(text)
    if (plain.ok) return { ok: true, hasSetup: false, file: { format: RUN_FORMAT, version: RUN_VERSION, created: '', app: '', note: '', setup: {}, report: plain.report } }
    return { ok: false, error: 'not a Crucible run file' }
  }
  if (typeof r.version !== 'number' || r.version > RUN_VERSION) return { ok: false, error: `made by a newer version of Crucible (run file version ${String(r.version)}): update the app to open it` }
  const rep = parseRunReport(JSON.stringify(r.report ?? null))
  if (!rep.ok) return { ok: false, error: `the run inside is damaged: ${rep.error}` }
  const setup: Values = {}
  if (r.setup && typeof r.setup === 'object') for (const [k, v] of Object.entries(r.setup as Record<string, unknown>)) if (/^[a-z][a-z0-9-]{0,40}$/.test(k) && (typeof v === 'string' || typeof v === 'boolean') && (typeof v !== 'string' || v.length < 200)) setup[k] = v
  return { ok: true, hasSetup: Object.keys(setup).length > 0, file: { format: RUN_FORMAT, version: RUN_VERSION, created: typeof r.created === 'string' ? r.created : '', app: typeof r.app === 'string' ? r.app : '', note: typeof r.note === 'string' ? r.note.slice(0, 300) : '', setup, report: rep.report } }
}
