// Worker for the calibration wizard: fits shots or the drive to measured CSV text, or makes example data. Everything it returns is plain data.
import { driveHtml, driveMarkdown, driveYaml, shotHtml, shotMarkdown, shotYaml } from './calreport'
import { parseAccel, parseShots } from './data'
import { fitDrive } from './drive'
import { defaultShotModel, fitShots, predictRange } from './shots'

export type CalIn =
  | { type: 'fit'; kind: 'shots' | 'drive'; csv: string; volts?: number; fitMass?: boolean }
  | { type: 'example'; kind: 'shots' | 'drive' }

export interface CalResult {
  kind: 'shots' | 'drive'
  /** the fitted values, named like the tuning parameters (efficiency, backspin / mu, mass) */
  values: Record<string, number>
  before: number
  after: number
  unit: string
  notes: string[]
  columns: [string, string, string]
  rows: [number, number | null, number | null][]
  evaluations: number
  yaml: string
  markdown: string
  html: string
}
export type CalOut = { type: 'result'; result: CalResult } | { type: 'example'; kind: 'shots' | 'drive'; csv: string } | { type: 'error'; message: string }

const post = (m: CalOut): void => (self as unknown as Worker).postMessage(m)

async function exampleShots(): Promise<string> {
  const d = defaultShotModel()
  const truth = { ...d, efficiency: d.efficiency * 0.92, backspin: d.backspin * 1.25 } // a robot a bit unlike the definition
  const lines = ['# example shots (made up from a model 8% less efficient, with more backspin): flywheel_rps, hood_deg, range_m', 'flywheel_rps,hood_deg,range_m']
  let n = 0
  for (const rps of [35, 45, 55, 65]) for (const hood of [25, 35, 45, 55]) {
    const r = await predictRange(truth, { flywheelRps: rps, hoodDeg: hood, height: 0, exitHeight: null })
    if (r !== null) lines.push(`${rps},${hood},${(r * (1 + 0.01 * Math.sin(++n * 12.9898))).toFixed(2)}`) // about 1% measurement scatter
  }
  return lines.join('\n') + '\n'
}

function exampleDrive(): string {
  const lines = ['# example straight-line drive at 12 V: t_s, speed_mps (made up: grip-limited start, then the motors run out of voltage)', 't_s,speed_mps']
  for (let i = 0; i <= 20; i++) { const t = i * 0.075; lines.push(`${t.toFixed(3)},${(4.1 * (1 - Math.exp(-t / 0.42)) + 0.02 * Math.sin(i * 7.3)).toFixed(3)}`) }
  return lines.join('\n') + '\n'
}

self.onmessage = async (ev: MessageEvent<CalIn>) => {
  const m = ev.data
  try {
    if (m.type === 'example') { post({ type: 'example', kind: m.kind, csv: m.kind === 'shots' ? await exampleShots() : exampleDrive() }); return }
    if (m.kind === 'shots') {
      const fit = await fitShots(parseShots(m.csv))
      post({
        type: 'result', result: {
          kind: 'shots', values: { efficiency: fit.model.efficiency, backspin: fit.model.backspin }, before: fit.before.rms, after: fit.after.rms, unit: 'm', notes: fit.notes,
          columns: ['measured (m)', 'predicted (m)', 'error (m)'], rows: fit.after.residuals.map((r) => [r.row.range, r.predicted, r.error]), evaluations: fit.fit.evaluations,
          yaml: shotYaml(fit), markdown: shotMarkdown(fit), html: shotHtml(fit),
        },
      })
    } else {
      const fit = await fitDrive(parseAccel(m.csv), { volts: m.volts ?? 12, fitMass: m.fitMass })
      post({
        type: 'result', result: {
          kind: 'drive', values: { mu: fit.model.mu, ...(m.fitMass ? { mass: fit.model.mass } : {}) }, before: fit.before.rms, after: fit.after.rms, unit: 'm/s', notes: [],
          columns: ['t (s)', 'measured (m/s)', 'model (m/s)'], rows: fit.after.residuals.map((r) => [r.t, r.measured, r.predicted]), evaluations: fit.fit.evaluations,
          yaml: driveYaml(fit), markdown: driveMarkdown(fit), html: driveHtml(fit),
        },
      })
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message })
  }
}
