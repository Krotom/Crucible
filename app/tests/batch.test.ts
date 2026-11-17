// The batch runner: `npm run batch -- runs/example.json` (see scripts/batch.mjs). Runs every script in the file on the real robot project in
// lockstep and writes a report per run plus a comparison table. Skipped unless CRUCIBLE_BATCH names a file.
import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { runOnRobot } from '../src/analysis/runner'
import { gradleRobot } from '../src/analysis/gradle'
import { comparisonTable, summaryLines, toHtml, toMarkdown } from '../src/analysis/report'
import type { RunReport } from '../src/analysis/recorder'
import type { RunScript } from '../src/analysis/script'

const file = process.env.CRUCIBLE_BATCH
const out = path.resolve(process.env.CRUCIBLE_OUT ?? 'runs/out')

/** A file holds one script, a list of scripts, or { scripts, seeds }: every script is repeated for each seed. */
export function loadScripts(text: string): RunScript[] {
  const j = JSON.parse(text)
  const list: RunScript[] = Array.isArray(j) ? j : j.scripts ? j.scripts : [j]
  const seeds: number[] | undefined = j.seeds
  if (!seeds) return list
  return list.flatMap((s) => seeds.map((seed) => ({ ...s, name: `${s.name}-seed${seed}`, seed })))
}

describe.skipIf(!file)('batch of scripted runs', () => {
  it('runs every script and writes the reports', async () => {
    const scripts = loadScripts(fs.readFileSync(path.resolve(file!), 'utf8'))
    fs.mkdirSync(out, { recursive: true })
    const reports: RunReport[] = []
    const log = (s: string): void => { fs.appendFileSync(path.join(out, 'batch.log'), s + '\n') }
    fs.writeFileSync(path.join(out, 'batch.log'), '')
    for (const script of scripts) {
      log(`running ${script.name} (${script.duration} s, seed ${script.seed})`)
      const t0 = Date.now()
      const r = await runOnRobot(script, gradleRobot(path.resolve(__dirname, '..')))
      const dir = path.join(out, script.name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r))
      fs.writeFileSync(path.join(dir, 'report.md'), toMarkdown(r))
      fs.writeFileSync(path.join(dir, 'report.html'), toHtml(r))
      reports.push(r)
      log(`done ${script.name} in ${((Date.now() - t0) / 1000).toFixed(0)} s wall`)
      for (const l of summaryLines(r)) log('  ' + l)
    }
    fs.writeFileSync(path.join(out, 'summary.md'), comparisonTable(reports))
    log('summary written')
  }, 3_600_000)
})
