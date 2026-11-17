// Fits the simulation to measured data: node scripts/calibrate.mjs shots data.csv | drive data.csv [--volts 12] [--mass] [--apply] [--out dir]
//   shots:   fits the launch efficiency and backspin to measured shots (columns in src/calibration/data.ts)
//   drive:   fits the tire friction (and with --mass the robot mass) to a measured straight-line acceleration
//   example: node scripts/calibrate.mjs example [--out dir] writes synthetic example data files
//   --apply writes the fitted values into robots/offseason/robot.yaml (git shows the change)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [mode, data, ...rest] = process.argv.slice(2)
if (!['shots', 'drive', 'example'].includes(mode)) {
  console.error('usage: node scripts/calibrate.mjs shots|drive <data.csv> [--volts 12] [--mass] [--apply] [--out dir]  |  example [--out dir]')
  process.exit(2)
}
const args = mode === 'example' ? [data, ...rest].filter(Boolean) : rest
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const out = path.resolve(opt('--out') ?? 'runs/calibration')
const env = { ...process.env, CRUCIBLE_CAL: mode, CRUCIBLE_OUT: out, CRUCIBLE_VOLTS: opt('--volts') ?? '12', CRUCIBLE_FIT_MASS: args.includes('--mass') ? '1' : '0', CRUCIBLE_APPLY: args.includes('--apply') ? '1' : '0' }
if (mode !== 'example') env.CRUCIBLE_DATA = path.resolve(data)
const r = spawnSync(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/calibrate.test.ts'], { stdio: 'inherit', env })
for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (/\.(md|txt)$/.test(f)) console.log(`\n--- ${f}\n${fs.readFileSync(path.join(out, f), 'utf8')}`)
process.exit(r.status ?? 1)
