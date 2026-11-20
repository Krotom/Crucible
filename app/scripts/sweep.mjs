// Runs the shot-accuracy sweep against the robot project: node scripts/sweep.mjs [--quick]. Needs the robot project and a JDK (starts Gradle once).
// The report lands in runs/sweep/latest.md (and latest.json).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const vitest = path.resolve('node_modules/vitest/vitest.mjs')
const env = { ...process.env, RUN_SWEEP: 'true', ...(process.argv.includes('--quick') ? { SWEEP_QUICK: '1' } : {}) }
const r = spawnSync(process.execPath, [vitest, 'run', 'tests/aim-sweep.test.ts'], { stdio: 'inherit', env })
const md = path.resolve('runs/sweep/latest.md')
if (fs.existsSync(md)) console.log('\n' + fs.readFileSync(md, 'utf8'))
process.exit(r.status ?? 1)
