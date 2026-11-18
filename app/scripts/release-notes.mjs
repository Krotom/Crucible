// Prints the release notes for a version, from the CHANGELOG in src/renderer/src/lib/versions.ts: node scripts/release-notes.mjs 1.1.0
// Exits with an error when the version has no entry, so a release cannot go out with empty notes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseChangelog(text) {
  const start = text.indexOf('export const CHANGELOG')
  if (start < 0) throw new Error('no CHANGELOG found')
  const open = text.indexOf('= [', start) + 2
  let depth = 0, end = -1
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++; continue }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) { end = i; break }
  }
  if (end < 0) throw new Error('the CHANGELOG list is not closed')
  return new Function(`return ${text.slice(open, end + 1)}`)()
}

export function notesFor(entries, version) {
  const e = entries.find((x) => x.version === version)
  if (!e) return null
  return `## ${e.title}\n\n${e.items.map((i) => `- ${i}`).join('\n')}\n`
}

const here = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const version = process.argv[2]
  if (!version) { console.error('usage: node scripts/release-notes.mjs <version>'); process.exit(2) }
  const src = fs.readFileSync(path.join(path.dirname(here), '..', 'src', 'renderer', 'src', 'lib', 'versions.ts'), 'utf8')
  const notes = notesFor(parseChangelog(src), version)
  if (!notes) { console.error(`no CHANGELOG entry for ${version}: add one to src/renderer/src/lib/versions.ts`); process.exit(1) }
  process.stdout.write(notes)
}
