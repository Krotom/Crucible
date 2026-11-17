// Runs a batch of scripted runs: node scripts/batch.mjs runs/example.json [outDir]
// Needs the robot project and a JDK (it starts Gradle for every script). Reports land in outDir (default runs/out).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/batch.mjs <runs.json> [outDir]'); process.exit(2) }
const out = path.resolve(process.argv[3] ?? 'runs/out')
const vitest = path.resolve('node_modules/vitest/vitest.mjs')
const r = spawnSync(process.execPath, [vitest, 'run', 'tests/batch.test.ts'], { stdio: 'inherit', env: { ...process.env, CRUCIBLE_BATCH: path.resolve(file), CRUCIBLE_OUT: out } })
for (const f of ['batch.log', 'summary.md']) { const p = path.join(out, f); if (fs.existsSync(p)) console.log(`\n--- ${f}\n${fs.readFileSync(p, 'utf8')}`) }
process.exit(r.status ?? 1)
