// Motor constants for the DC motor models, built the way WPILib's DCMotor builds them from the published free speed,
// stall torque, stall current and free current, so a mechanism here behaves like the robot's current DCMotorSim.
const TWO_PI = 2 * Math.PI
const NOMINAL_VOLTS = 12

export interface MotorModel {
  /** Torque constant, N*m per amp (of total current). */
  kt: number
  /** Back-EMF constant, V per rad/s. */
  ke: number
  /** Winding resistance, ohm (for n motors in parallel: one motor's resistance over n). */
  resistance: number
}

function fromSpec(freeRpm: number, stallTorque: number, stallAmps: number, freeAmps: number): MotorModel {
  const resistance = NOMINAL_VOLTS / stallAmps
  const freeSpeed = (freeRpm * TWO_PI) / 60
  return { kt: stallTorque / stallAmps, ke: (NOMINAL_VOLTS - resistance * freeAmps) / freeSpeed, resistance }
}

/** Kraken X60: 6000 rpm, 7.09 N*m, 366 A stall, 2 A free (as in WPILib). */
export const KRAKEN_X60: MotorModel = fromSpec(6000, 7.09, 366, 2)
/** Kraken X44 (7530 rpm, 4.05 N*m, 275 A stall): the constants of WPILib 2026 DCMotor.getKrakenX44, taken from it directly. */
export const KRAKEN_X44: MotorModel = { kt: 0.014731183, ke: 1 / 68.190139892, resistance: 0.043010753 }

export const MOTORS: Record<string, MotorModel> = { krakenX60: KRAKEN_X60, krakenX44: KRAKEN_X44 }

/**
 * n identical motors on one shaft. Each draws the same current for the same voltage, so the total current is n times
 * larger: resistance over n, and the torque constant (per amp of total current) and back-EMF constant stay the same.
 */
export function parallel(m: MotorModel, n: number): MotorModel {
  return { kt: m.kt, ke: m.ke, resistance: m.resistance / n }
}
