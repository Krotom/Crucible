// Text for a calibration: what was fitted, how well it fits (before and after), the residuals, and the lines to put into robot.yaml.
import { lineChart, page } from '../analysis/report'
import type { DriveFit } from './drive'
import type { ShotFit } from './shots'

const f = (x: number | null | undefined, d = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d))

/** The values to put into the robot definition for a shot fit. */
export function shotYaml(fit: ShotFit): string {
  return [`# from a shot fit of ${fit.after.residuals.length} shots (rms ${f(fit.before.rms)} m before, ${f(fit.after.rms)} m after)`, `efficiency: ${f(fit.model.efficiency, 3)}`, `backspin: ${f(fit.model.backspin, 3)}`].join('\n')
}

export function driveYaml(fit: DriveFit): string {
  return [`# from an acceleration fit of ${fit.after.residuals.length} samples (rms ${f(fit.before.rms)} m/s before, ${f(fit.after.rms)} m/s after)`, `mu: ${f(fit.model.mu, 3)}`, ...(fit.model.mass ? [`mass: ${f(fit.model.mass, 1)}`] : [])].join('\n')
}

/**
 * Replaces the value of top-level-looking keys in a robot definition's text (a line "  key: value  # comment" keeps its comment). Keys that
 * are not found are reported, never added, so a typo cannot corrupt the file.
 */
export function applyToYaml(text: string, values: Record<string, number>): { text: string; missing: string[] } {
  const missing: string[] = []
  let out = text
  for (const [key, v] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*${key}:\\s*)(-?[0-9.]+)(.*)$`, 'm')
    if (!re.test(out)) { missing.push(key); continue }
    out = out.replace(re, (_m, a: string, _old: string, c: string) => `${a}${v}${c.replace(/GUESS[^,]*?(?=$)/, 'FIT')}`)
  }
  return { text: out, missing }
}

export function shotMarkdown(fit: ShotFit): string {
  const rows = fit.after.residuals.map((r, i) => `| ${i + 1} | ${f(r.row.flywheelRps, 1)} | ${f(r.row.hoodDeg, 1)} | ${f(r.row.range, 2)} | ${f(r.predicted, 2)} | ${f(r.error, 2)} |`)
  return ['# Shot calibration', '', `efficiency ${f(fit.model.efficiency)}, backspin ${f(fit.model.backspin)}; rms error ${f(fit.before.rms)} m before, ${f(fit.after.rms)} m after (${fit.fit.evaluations} simulations)`, '',
    ...(fit.notes.length ? ['**Check:**', ...fit.notes.map((n) => '- ' + n), ''] : []), '| # | flywheel (rps) | hood (deg) | measured (m) | predicted (m) | error (m) |', '|---|---|---|---|---|---|', ...rows, '', '```yaml', shotYaml(fit), '```', ''].join('\n')
}

export function driveMarkdown(fit: DriveFit): string {
  return ['# Drivetrain calibration', '', `tire friction mu ${f(fit.model.mu)}${fit.model.mass ? `, mass ${f(fit.model.mass, 1)} kg` : ''}; rms error ${f(fit.before.rms)} m/s before, ${f(fit.after.rms)} m/s after`, '', '```yaml', driveYaml(fit), '```', ''].join('\n')
}

export function shotHtml(fit: ShotFit): string {
  const pts = fit.after.residuals.filter((r) => r.predicted !== null).sort((a, b) => a.row.range - b.row.range)
  const chart = lineChart('Predicted against measured range (a perfect fit is the diagonal)', [
    { label: 'measured', color: 'var(--accent)', points: pts.map((r) => [r.row.range, r.row.range]) },
    { label: 'predicted', color: 'var(--red)', points: pts.map((r) => [r.row.range, r.predicted as number]) },
  ], 640, 260, 'predicted m')
  const rows = fit.after.residuals.map((r, i) => `<tr><td>${i + 1}</td><td>${f(r.row.flywheelRps, 1)}</td><td>${f(r.row.hoodDeg, 1)}</td><td>${f(r.row.range, 2)}</td><td>${f(r.predicted, 2)}</td><td>${f(r.error, 2)}</td></tr>`).join('')
  return page('Shot calibration', `efficiency ${f(fit.model.efficiency)}, backspin ${f(fit.model.backspin)}; rms error ${f(fit.before.rms)} m before, ${f(fit.after.rms)} m after`,
    `${chart}${fit.notes.map((n) => `<p class="sub">Check: ${n}</p>`).join("")}<pre>${shotYaml(fit)}</pre><table><tr><th>#</th><th>flywheel (rps)</th><th>hood (deg)</th><th>measured (m)</th><th>predicted (m)</th><th>error (m)</th></tr>${rows}</table>`)
}

export function driveHtml(fit: DriveFit): string {
  const chart = lineChart('Speed after the start', [
    { label: 'measured', color: 'var(--accent)', points: fit.after.residuals.map((r) => [r.t, r.measured]) },
    { label: 'model', color: 'var(--red)', points: fit.after.residuals.map((r) => [r.t, r.predicted]) },
  ], 640, 260, 'm/s')
  return page('Drivetrain calibration', `tire friction mu ${f(fit.model.mu)}; rms error ${f(fit.before.rms)} m/s before, ${f(fit.after.rms)} m/s after`, `${chart}<pre>${driveYaml(fit)}</pre>`)
}
