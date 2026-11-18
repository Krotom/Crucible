// Session presets: a named snapshot of the setup controls (game, mode, opponent, start position, battery, vision ...) kept in local storage,
// so "Qualification 3, red, cycler, brownout at 7 V" is one click.
const KEY = 'crucible-presets'
const MAX = 30
export type Values = Record<string, string | boolean>
export interface Preset { name: string; values: Values; saved: number }

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function cleanName(name: string): string { return name.replace(/\s+/g, ' ').trim().slice(0, 40) }

export class PresetStore {
  constructor(private store: KeyValueStore | null) {}

  list(): Preset[] {
    try {
      const raw = JSON.parse(this.store?.getItem(KEY) ?? '[]') as unknown
      if (!Array.isArray(raw)) return []
      const out: Preset[] = []
      for (const p of raw) {
        if (!p || typeof p.name !== 'string' || !p.values || typeof p.values !== 'object') continue
        const values: Values = {}
        for (const [k, v] of Object.entries(p.values as Record<string, unknown>)) if (typeof v === 'string' || typeof v === 'boolean') values[k] = v
        out.push({ name: p.name, values, saved: typeof p.saved === 'number' ? p.saved : 0 })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    } catch { return [] }
  }

  private write(all: Preset[]): boolean {
    try { this.store?.setItem(KEY, JSON.stringify(all)); return this.store !== null } catch { return false }
  }

  /** Saves (or replaces, by name, ignoring case) a preset. Returns an error text, or null on success. */
  save(name: string, values: Values, now = Date.now()): string | null {
    const n = cleanName(name)
    if (!n) return 'Give the preset a name first'
    const all = this.list().filter((p) => p.name.toLowerCase() !== n.toLowerCase())
    if (all.length >= MAX) return `At most ${MAX} presets: delete one first`
    all.push({ name: n, values: { ...values }, saved: now })
    return this.write(all) ? null : 'Could not store the preset (browser storage is unavailable)'
  }

  get(name: string): Preset | undefined { return this.list().find((p) => p.name.toLowerCase() === cleanName(name).toLowerCase()) }

  delete(name: string): boolean {
    const all = this.list(), rest = all.filter((p) => p.name.toLowerCase() !== cleanName(name).toLowerCase())
    if (rest.length === all.length) return false
    return this.write(rest)
  }
}

/** Reads the controls' current values; unknown ids are skipped. */
export function captureValues(ids: string[], read: (id: string) => string | boolean | undefined): Values {
  const v: Values = {}
  for (const id of ids) { const x = read(id); if (x !== undefined) v[id] = x }
  return v
}
