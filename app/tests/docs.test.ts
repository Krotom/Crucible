import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { keyLabel, SHORTCUTS } from '../src/renderer/src/lib/shortcuts'

// The documents are checked against the repository so they cannot drift quietly: links resolve, every npm script and script file they name exists,
// every shortcut is in the README, and the files a document says exist are there.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', 'out', 'dist-release', 'dist-installer'].includes(e)) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) markdownFiles(p, out)
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}
const docs = markdownFiles(root)
const text = (p: string): string => readFileSync(p, 'utf8')
const rel = (p: string): string => p.slice(root.length + 1)

describe('the documents', () => {
  it('finds them (the root README, the app README and the docs folder)', () => {
    const names = docs.map(rel)
    for (const n of ['README.md', 'app/README.md', 'docs/PLAN.md', 'docs/RELEASING.md', 'docs/TESTING.md', 'docs/IDEAS.md', 'docs/NT_CONTRACT.md']) expect(names).toContain(n)
  })
  it('only link to files that exist', () => {
    const broken: string[] = []
    for (const d of docs) for (const m of text(d).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0]
      if (!target || /^[a-z]+:/.test(target)) continue // anchors and web links
      if (!existsSync(resolve(dirname(d), target))) broken.push(`${rel(d)} -> ${m[1]}`)
    }
    expect(broken).toEqual([])
  })
  it('only name npm scripts that exist', () => {
    const missing: string[] = []
    for (const d of docs) for (const m of text(d).matchAll(/npm run ([a-z][\w:-]*)/g)) if (!(m[1] in pkg.scripts)) missing.push(`${rel(d)}: npm run ${m[1]}`)
    expect(missing).toEqual([])
  })
  it('only name script, example and workflow files that exist', () => {
    const missing: string[] = []
    for (const d of docs) for (const m of text(d).matchAll(/`((?:app\/)?(?:scripts|e2e|examples|installer)\/[\w./-]+\.(?:mjs|js|ps1|nsi)|\.github\/workflows\/[\w.-]+\.yml)`/g)) {
      const p = m[1]
      if (!existsSync(join(root, p)) && !existsSync(join(root, 'app', p))) missing.push(`${rel(d)}: ${p}`)
    }
    expect(missing).toEqual([])
  })
  it('list every keyboard shortcut in the app README', () => {
    const readme = text(join(root, 'app', 'README.md'))
    const missing = SHORTCUTS.filter((s) => keyLabel(s.key).length > 1 && !/^[2-5]$/.test(s.key)).map((s) => keyLabel(s.key)).filter((l) => !readme.includes(l))
    expect(missing).toEqual([])
    expect(readme).toMatch(/1 to 5/)
  })
  it('do not claim the checklist has open items while it has, or the other way round', () => {
    const ideas = text(join(root, 'docs', 'IDEAS.md'))
    const open = (ideas.match(/^- \[ \]/gm) ?? []).length
    expect(/Every item is done/.test(ideas)).toBe(open === 0)
  })
  it('carry the version the package has wherever a document names the current release files', () => {
    for (const d of docs) for (const m of text(d).matchAll(/BALTA-Crucible-(\d+\.\d+\.\d+)-/g)) expect(m[1], `${rel(d)} names version ${m[1]}`).toBe(JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8')).version)
  })
})
