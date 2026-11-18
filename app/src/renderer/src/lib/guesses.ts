// Which values in the robot definition are measured and which are still guesses: read from the source tags in robot.yaml's comments
// (`# GUESS: ...`, `# CODE ...`, `# CAD ...`, `# FIT ...`, `# ASSUMED ...`).
export type NoteTag = 'GUESS' | 'CODE' | 'CAD' | 'FIT' | 'ASSUMED'
export interface ParamNote { path: string; value: string; tag: NoteTag; note: string }

const TAGS = /^#\s*(GUESS|CODE|CAD|FIT|ASSUMED)\b[:,]?\s*(.*)$/

export function parseParamNotes(yamlText: string): ParamNote[] {
  const out: ParamNote[] = []
  let section = ''
  for (const raw of yamlText.split(/\r?\n/)) {
    const top = /^([A-Za-z]\w*):\s*(.*)$/.exec(raw)
    if (top) section = top[1]
    const hash = raw.indexOf(' #')
    if (hash < 0) continue
    const m = TAGS.exec(raw.slice(hash + 1).trim())
    if (!m) continue
    const left = raw.slice(0, hash).trim()
    let key = '', value = ''
    const item = /^-\s*\{(.*)\}$/.exec(left)
    if (item) {
      const name = /\bname:\s*([\w-]+)/.exec(item[1])
      if (!name) continue
      key = name[1]; value = item[1].trim()
    } else {
      const kv = /^([A-Za-z]\w*):\s*(.+)$/.exec(left)
      if (!kv) continue
      key = kv[1]; value = kv[2].trim()
    }
    out.push({ path: top ? key : `${section}.${key}`, value, tag: m[1] as NoteTag, note: m[2].trim() })
  }
  return out
}

export function summarize(notes: ParamNote[]): { guesses: number; total: number; byTag: Record<NoteTag, number> } {
  const byTag: Record<NoteTag, number> = { GUESS: 0, CODE: 0, CAD: 0, FIT: 0, ASSUMED: 0 }
  for (const n of notes) byTag[n.tag]++
  return { guesses: byTag.GUESS + byTag.ASSUMED, total: notes.length, byTag }
}
