// The calibration runner: `npm run calibrate -- shots data.csv` or `-- drive accel.csv` (see scripts/calibrate.mjs). Skipped unless CRUCIBLE_CAL is set.
//   CRUCIBLE_CAL=shots|drive|example   CRUCIBLE_DATA=file.csv   CRUCIBLE_OUT=dir   CRUCIBLE_VOLTS=12   CRUCIBLE_FIT_MASS=1   CRUCIBLE_APPLY=1
import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseAccel, parseShots } from '../src/calibration/data'
import { fitShots, defaultShotModel, predictRange, type ShotModel } from '../src/calibration/shots'
import { fitDrive, simulateAcceleration } from '../src/calibration/drive'
import { applyToYaml, driveHtml, driveMarkdown, shotHtml, shotMarkdown } from '../src/calibration/calreport'
import { Engine } from '../src/engine/engine'
import { OFFSEASON } from '../src/robots/offseason'

const mode = process.env.CRUCIBLE_CAL
const out = path.resolve(process.env.CRUCIBLE_OUT ?? 'runs/calibration')
const yamlPath = path.resolve(__dirname, '../robots/offseason/robot.yaml')
const fitMass = process.env.CRUCIBLE_FIT_MASS === '1'

function applyYaml(values: Record<string, number>, what: string): void {
  const r = applyToYaml(fs.readFileSync(yamlPath, 'utf8'), values)
  fs.writeFileSync(yamlPath, r.text)
  fs.appendFileSync(path.join(out, 'applied.txt'), `robot.yaml: ${what} updated${r.missing.length ? `; not found: ${r.missing.join(', ')}` : ''}\n`)
}

describe.skipIf(!mode)('calibration', () => {
  it('fits the measured data and writes the report', async () => {
    fs.mkdirSync(out, { recursive: true })
    if (mode === 'shots') {
      const fit = await fitShots(parseShots(fs.readFileSync(path.resolve(process.env.CRUCIBLE_DATA!), 'utf8')))
      fs.writeFileSync(path.join(out, 'shots.md'), shotMarkdown(fit))
      fs.writeFileSync(path.join(out, 'shots.html'), shotHtml(fit))
      if (process.env.CRUCIBLE_APPLY === '1') applyYaml({ efficiency: +fit.model.efficiency.toFixed(3), backspin: +fit.model.backspin.toFixed(3) }, 'efficiency and backspin')
    } else if (mode === 'drive') {
      const fit = await fitDrive(parseAccel(fs.readFileSync(path.resolve(process.env.CRUCIBLE_DATA!), 'utf8')), { volts: Number(process.env.CRUCIBLE_VOLTS ?? 12), fitMass })
      fs.writeFileSync(path.join(out, 'drive.md'), driveMarkdown(fit))
      fs.writeFileSync(path.join(out, 'drive.html'), driveHtml(fit))
      if (process.env.CRUCIBLE_APPLY === '1') applyYaml({ mu: +fit.model.mu.toFixed(3), ...(fitMass ? { mass: +fit.model.mass.toFixed(1) } : {}) }, fitMass ? 'mu and mass' : 'mu')
    } else if (mode === 'example') {
      // synthetic example files, so the format and the workflow can be tried before any real data exists
      const truth: ShotModel = { ...defaultShotModel(), efficiency: 0.62, backspin: 0.22 }
      const lines = ['# SYNTHETIC example (made from efficiency 0.62, backspin 0.22): replace with measured shots', 'flywheel_rps,hood_deg,range_m']
      for (const [rps, hood] of [[40, 62], [45, 58], [50, 66], [55, 60], [60, 64], [65, 57], [48, 70], [52, 55]]) {
        const r = await predictRange(truth, { flywheelRps: rps, hoodDeg: hood, height: 0, exitHeight: null })
        lines.push(`${rps},${hood},${r!.toFixed(2)}`)
      }
      fs.writeFileSync(path.join(out, 'example-shots.csv'), lines.join('\n') + '\n')
      const spec = { ...OFFSEASON.drivetrain, mu: 0.9 }
      const e = await Engine.create({
        game: { id: 'g', field: () => ({ length: 200, width: 200, colliders: [{ center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 0.2 }], sensors: [] }), pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.5, dragCoefficient: 0, rollingDamping: 0, color: 0 }], initialLayout: () => [], matchFlow: () => ({ phases: [{ name: 'p', duration: Infinity }] }), onEvent: () => [], hud: () => ({ title: 'g' }) },
        robot: { half: OFFSEASON.bumper, start: { x: -90, y: 0, yaw: 0 }, script: [], drivetrain: spec, chassis: OFFSEASON.contact }, seed: 1, dt: 0.002,
      })
      const times = Array.from({ length: 21 }, (_, i) => i * 0.1)
      const sp = simulateAcceleration(e, spec, times, 12)
      fs.writeFileSync(path.join(out, 'example-accel.csv'), ['# SYNTHETIC example (made from mu 0.9, 12 V): replace with a logged straight-line drive from standstill', 't_s,speed_mps', ...times.map((t, i) => `${t.toFixed(1)},${sp[i].toFixed(3)}`)].join('\n') + '\n')
    }
  }, 600_000)
})
