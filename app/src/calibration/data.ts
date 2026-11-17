// Measured data for calibration, as plain CSV with a header row (lines starting with # and blank lines are skipped).
//
//   shots.csv      one row per shot:     flywheel_rps, hood_deg, range_m [, height_m [, exit_height_m]]
//                  flywheel_rps  the flywheel (wheel) speed at the moment of the shot, rotations per second
//                  hood_deg      the launch elevation above horizontal, degrees
//                  range_m       how far the FUEL travelled horizontally from the exit point when it came down through height_m
//                  height_m      the height the range was measured at (default 0: where it landed on the floor)
//                  exit_height_m height of the exit above the floor (default: the robot definition's)
//
//   accel.csv      one row per sample of a straight-line drive at a constant voltage: t_s, speed_mps
//                  (t_s = 0 at the moment the drive started; the voltage is given when fitting, default 12)
export interface ShotRow { flywheelRps: number; hoodDeg: number; range: number; height: number; exitHeight: number | null }
export interface AccelRow { t: number; speed: number }

function rows(text: string): string[][] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  return lines.slice(1).map((l) => l.split(/[,;\t]/).map((c) => c.trim()))
}

function num(s: string | undefined, what: string, line: number): number {
  const v = Number(s)
  if (s === undefined || s === '' || !Number.isFinite(v)) throw new Error(`line ${line}: ${what} must be a number (got "${s ?? ''}")`)
  return v
}

export function parseShots(text: string): ShotRow[] {
  return rows(text).map((c, i) => ({
    flywheelRps: num(c[0], 'flywheel_rps', i + 2),
    hoodDeg: num(c[1], 'hood_deg', i + 2),
    range: num(c[2], 'range_m', i + 2),
    height: c[3] === undefined || c[3] === '' ? 0 : num(c[3], 'height_m', i + 2),
    exitHeight: c[4] === undefined || c[4] === '' ? null : num(c[4], 'exit_height_m', i + 2),
  }))
}

export function parseAccel(text: string): AccelRow[] {
  return rows(text).map((c, i) => ({ t: num(c[0], 't_s', i + 2), speed: num(c[1], 'speed_mps', i + 2) }))
}
