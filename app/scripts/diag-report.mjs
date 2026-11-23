// Summarises a memory diagnostics log (npm run diag writes it): node scripts/diag-report.mjs [file]   (default: the newest in %APPDATA%\BALTA Crucible\logs)
// Prints one row per minute (process memory, the page's own numbers, what the user did) and the intervals where memory grew fastest.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'BALTA Crucible', 'logs')
const file = process.argv[2] ?? fs.readdirSync(dir).filter((f) => /^diag-.*\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f)).pop()
if (!file) { console.error('no diagnostics log found in ' + dir); process.exit(2) }
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const header = rows.find((r) => r.kind === 'header')
const samples = rows.filter((r) => r.kind === 'sample')
console.log(`file ${file}`)
if (header) console.log(`app ${header.app}, electron ${header.electron}; graphics: webgl ${header.gpuFeatures?.webgl}, compositing ${header.gpuFeatures?.gpu_compositing}, rasterization ${header.gpuFeatures?.rasterization}`)
console.log(`${samples.length} samples over ${samples.length ? samples[samples.length - 1].t : 0} s`)

const fmt = (x) => (x === null || x === undefined ? '-' : String(x))
console.log('\n  t(s)  app MB  gpu MB  page MB  free MB | heap  geos tex | samples  plot  fps  tab        | what happened')
let lastPrinted = -999
let pendingEvents = []
for (const s of samples) {
  const p = s.page ?? {}
  for (const e of p.events ?? []) pendingEvents.push(e)
  if (s.t - lastPrinted < 60 && s !== samples[samples.length - 1]) continue
  lastPrinted = s.t
  const ev = pendingEvents.filter((e) => e.type !== 'focus' && e.type !== 'blur').map((e) => `${e.type}:${(e.what ?? e.value ?? '').slice(0, 28)}`)
  const shown = ev.length > 6 ? [...ev.slice(0, 5), `…+${ev.length - 5} more`] : ev
  console.log(`${String(s.t).padStart(6)} ${String(s.appMB).padStart(7)} ${String(s.gpuProcessMB).padStart(7)} ${String(s.pageProcessMB).padStart(8)} ${String(s.system?.freeMB).padStart(8)} | ${fmt(p.heap?.usedMB).padStart(4)} ${fmt(p.three?.geometries).padStart(5)} ${fmt(p.three?.textures).padStart(3)} | ${fmt(p.store?.samples).padStart(7)} ${fmt(p.store?.plotted).padStart(5)} ${fmt(p.page?.fps).padStart(4)} ${fmt(p.page?.tab).padEnd(10)} | ${shown.join(' ; ')}`)
  pendingEvents = []
}

// where memory grew the most between consecutive samples, with what the user did just before
const growth = []
for (let i = 1; i < samples.length; i++) growth.push({ i, d: samples[i].appMB - samples[i - 1].appMB, from: samples[i - 1].t, to: samples[i].t })
growth.sort((a, b) => b.d - a.d)
console.log('\nbiggest jumps between samples:')
for (const g of growth.slice(0, 5)) {
  const a = samples[g.i - 1], b = samples[g.i]
  const ev = (b.page?.events ?? []).filter((e) => e.type !== 'focus' && e.type !== 'blur').map((e) => `${e.type}:${(e.what ?? e.value ?? '').slice(0, 30)}`).slice(0, 8)
  console.log(`  +${g.d} MB (${a.appMB} -> ${b.appMB}) at ${g.from}-${g.to} s: gpu ${a.gpuProcessMB}->${b.gpuProcessMB}, page ${a.pageProcessMB}->${b.pageProcessMB}; events: ${ev.join(' ; ') || 'none'}`)
}
const marks = rows.filter((r) => r.kind === 'mark')
if (marks.length) { console.log('\nmarks:'); for (const m of marks) console.log(`  ${m.t} s: ${m.text}`) }
const first = samples[0], last = samples[samples.length - 1]
if (first && last && last.t > first.t) {
  const mins = (last.t - first.t) / 60
  console.log(`\nover the whole log: app ${first.appMB} -> ${last.appMB} MB (${((last.appMB - first.appMB) / mins).toFixed(0)} MB/min); gpu ${first.gpuProcessMB} -> ${last.gpuProcessMB}; page ${first.pageProcessMB} -> ${last.pageProcessMB}`)
}
