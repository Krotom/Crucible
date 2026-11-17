// Drivetrain calibration: fits the tire friction (and optionally the robot mass) to a measured straight-line acceleration at a constant voltage,
// by driving the same swerve model the engine uses and comparing speed against time.
import { Engine } from '../engine/engine'
import type { DrivetrainSpec } from '../engine/drivetrain'
import type { GameModule } from '../engine/types'
import { OFFSEASON } from '../robots/offseason'
import type { AccelRow } from './data'
import { nelderMead, rms, type FitResult } from './optimize'

export interface DriveModel { mu: number; mass: number; slipSpeed: number }

export function defaultDriveModel(): DriveModel {
  const d = OFFSEASON.drivetrain
  return { mu: d.mu, mass: d.mass, slipSpeed: d.slipSpeed }
}

function floorGame(): GameModule {
  return {
    id: 'calibration-drive',
    field: () => ({ length: 200, width: 200, colliders: [{ center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 0.2, label: 'floor' }], sensors: [] }),
    pieces: () => [{ id: 'ball', radius: 0.075, mass: 0.2, friction: 0.6, restitution: 0.5, dragCoefficient: 0, rollingDamping: 0, color: 0 }],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: () => [],
    hud: () => ({ title: 'calibration' }),
  }
}

let engine: Engine | null = null
let engineSpec: DrivetrainSpec | null = null

async function driveEngine(spec: DrivetrainSpec): Promise<Engine> {
  if (engine && engineSpec === spec) { engine.reset(1); return engine }
  engine = await Engine.create({ game: floorGame(), robot: { half: OFFSEASON.bumper, start: { x: -90, y: 0, yaw: 0 }, script: [], drivetrain: spec, chassis: OFFSEASON.contact }, seed: 1, dt: 0.002 })
  engineSpec = spec
  return engine
}

/** The speed the model reaches at each of the given times when every drive motor is held at `volts` (positive: forward), steering straight. */
export function simulateAcceleration(e: Engine, spec: DrivetrainSpec, times: number[], volts: number): number[] {
  e.reset(1)
  for (const m of spec.modules) { e.drivetrain!.setVolts(m.driveId, volts); e.drivetrain!.setVolts(m.steerId, 0) }
  const sorted = times.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t)
  const res = new Array<number>(times.length)
  for (const { t, i } of sorted) {
    while (e.time < t - 1e-9) e.step()
    res[i] = e.getFrame(false).robotSpeed
  }
  return res
}

function specFor(m: DriveModel): DrivetrainSpec { return { ...OFFSEASON.drivetrain, mu: m.mu, mass: m.mass, slipSpeed: m.slipSpeed } }

export interface DriveFit {
  model: DriveModel
  fit: FitResult
  before: { rms: number }
  after: { rms: number; residuals: { t: number; measured: number; predicted: number }[] }
}

export async function fitDrive(data: AccelRow[], opts: { volts?: number; fitMass?: boolean; start?: DriveModel; maxEvaluations?: number } = {}): Promise<DriveFit> {
  if (data.length < 5) throw new Error('need at least 5 samples of speed against time')
  const volts = opts.volts ?? 12
  const start = opts.start ?? defaultDriveModel()
  const times = data.map((d) => d.t)
  const costFor = async (m: DriveModel): Promise<{ cost: number; predicted: number[] }> => {
    const spec = specFor(m)
    const e = await Engine.create({ game: floorGame(), robot: { half: OFFSEASON.bumper, start: { x: -90, y: 0, yaw: 0 }, script: [], drivetrain: spec, chassis: OFFSEASON.contact }, seed: 1, dt: 0.002 })
    const predicted = simulateAcceleration(e, spec, times, volts)
    return { cost: rms(predicted.map((p, i) => p - data[i].speed)), predicted }
  }
  // the simplex is synchronous, so every candidate model needs an engine built ahead: keep one engine and swap the drivetrain spec in place
  const base = await driveEngine(specFor(start))
  const dt = base.drivetrain!
  const costSync = (x: number[]): number => {
    const m: DriveModel = { mu: x[0], mass: opts.fitMass ? x[1] : start.mass, slipSpeed: start.slipSpeed }
    Object.assign(dt.spec, specFor(m)) // read again by reset(): the chassis mass and the tires come from the spec
    return rms(simulateAcceleration(base, dt.spec, times, volts).map((p, i) => p - data[i].speed))
  }
  const before = (await costFor(start)).cost
  const fit = opts.fitMass
    ? nelderMead(costSync, [start.mu, start.mass], [{ min: 0.3, max: 2.5 }, { min: 20, max: 90 }], { maxEvaluations: opts.maxEvaluations ?? 80, tolerance: 1e-7 })
    : nelderMead((x) => costSync([x[0]]), [start.mu], [{ min: 0.3, max: 2.5 }], { maxEvaluations: opts.maxEvaluations ?? 60, tolerance: 1e-7 })
  const model: DriveModel = { mu: fit.x[0], mass: opts.fitMass ? fit.x[1] : start.mass, slipSpeed: start.slipSpeed }
  const final = await costFor(model)
  return {
    model, fit, before: { rms: before },
    after: { rms: final.cost, residuals: data.map((d, i) => ({ t: d.t, measured: d.speed, predicted: final.predicted[i] })) },
  }
}
