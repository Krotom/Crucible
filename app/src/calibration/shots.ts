// Shot calibration: fits the launch efficiency (FUEL speed over flywheel surface speed) and the backspin to measured shots, using the same
// flight model the engine plays (drag, Magnus lift), so what the fit finds is what the simulation will do.
import { Engine } from '../engine/engine'
import type { GameModule, PieceSpec } from '../engine/types'
import { FUEL } from '../games/rebuilt'
import { TEST_ROBOT } from '../games/test'
import { OFFSEASON } from '../robots/offseason'
import type { ShotRow } from './data'
import { nelderMead, rms, type FitResult } from './optimize'

const TWO_PI = 2 * Math.PI

export interface ShotModel {
  /** FUEL speed over flywheel surface speed */
  efficiency: number
  /** spin parameter at launch, r * w / v */
  backspin: number
  wheelRadius: number
  exitHeight: number
  piece: PieceSpec
}

export function defaultShotModel(): ShotModel {
  const sh = OFFSEASON.balls!.shooter
  return { efficiency: sh.efficiency, backspin: sh.backspin, wheelRadius: sh.wheelRadius, exitHeight: sh.exitHeight, piece: FUEL }
}

function flightGame(piece: PieceSpec): GameModule {
  return {
    id: 'calibration',
    field: () => ({ length: 100, width: 100, colliders: [{ center: [0, 0, -0.1], half: [100, 100, 0.1], friction: 0.8, restitution: 0.5, label: 'floor' }], sensors: [] }),
    pieces: () => [piece],
    initialLayout: () => [],
    matchFlow: () => ({ phases: [{ name: 'play', duration: Infinity }] }),
    onEvent: () => [],
    hud: () => ({ title: 'calibration' }),
  }
}

let cached: { piece: PieceSpec; engine: Engine } | null = null
async function flightEngine(piece: PieceSpec): Promise<Engine> {
  if (cached && cached.piece === piece) { cached.engine.reset(1); return cached.engine }
  const engine = await Engine.create({ game: flightGame(piece), robot: { ...TEST_ROBOT, start: { x: -50, y: -50, yaw: 0 } }, seed: 1, dt: 0.004 })
  cached = { piece, engine }
  return engine
}

/** Horizontal distance from the exit at which a shot comes down through the given height (the floor is height 0: the ball's lowest point lands), or null if it never does within 6 s. */
export function predictRangeSync(engine: Engine, m: ShotModel, row: Pick<ShotRow, 'flywheelRps' | 'hoodDeg' | 'height' | 'exitHeight'>): number | null {
  engine.reset(1)
  const speed = m.efficiency * TWO_PI * m.wheelRadius * Math.abs(row.flywheelRps)
  const th = (row.hoodDeg * Math.PI) / 180
  const z0 = row.exitHeight ?? m.exitHeight
  const w = (m.backspin * speed) / m.piece.radius
  const id = engine.spawn({ spec: m.piece.id, position: [0, 0, z0], velocity: [speed * Math.cos(th), 0, speed * Math.sin(th)], angularVelocity: [0, -w, 0] })
  const target = row.height + (row.height > 0 ? 0 : m.piece.radius)
  let prevZ = z0
  let prevX = 0
  let down = false
  for (let i = 0; i < 1500; i++) {
    engine.step()
    const s = engine.pieceState(id)
    if (!s) return null
    if (s.velocity[2] < 0) down = true
    const [x, , z] = s.position
    if (down && prevZ > target && z <= target) return prevX + ((prevZ - target) / (prevZ - z)) * (x - prevX)
    prevZ = z
    prevX = x
  }
  return null
}

export async function predictRange(m: ShotModel, row: Pick<ShotRow, 'flywheelRps' | 'hoodDeg' | 'height' | 'exitHeight'>): Promise<number | null> {
  return predictRangeSync(await flightEngine(m.piece), m, row)
}

export interface ShotResidual { row: ShotRow; predicted: number | null; error: number | null }

export interface ShotFit {
  model: ShotModel
  fit: FitResult
  before: { rms: number }
  after: { rms: number; residuals: ShotResidual[] }
  /** plain-language warnings, e.g. a parameter this data does not pin down */
  notes: string[]
}

/** A shot that never comes down counts as a miss of 10 m, so the fit is pushed away from parameters that cannot reach the data. */
const MISS = 10

export async function shotResiduals(m: ShotModel, data: ShotRow[]): Promise<ShotResidual[]> {
  const engine = await flightEngine(m.piece)
  return data.map((row) => {
    const p = predictRangeSync(engine, m, row)
    return { row, predicted: p, error: p === null ? null : p - row.range }
  })
}

const rmsOf = (r: ShotResidual[]): number => rms(r.map((x) => x.error ?? MISS))

export async function fitShots(data: ShotRow[], start: ShotModel = defaultShotModel(), opts: { maxEvaluations?: number } = {}): Promise<ShotFit> {
  if (data.length < 3) throw new Error('need at least 3 shots to fit efficiency and backspin')
  const engine = await flightEngine(start.piece)
  const before = rmsOf(await shotResiduals(start, data))
  const costOf = (x: number[]): number => rmsOf(data.map((row) => {
    const p = predictRangeSync(engine, { ...start, efficiency: x[0], backspin: x[1] }, row)
    return { row, predicted: p, error: p === null ? null : p - row.range }
  }))
  const fit = nelderMead(costOf, [start.efficiency, start.backspin], [{ min: 0.1, max: 1.2 }, { min: 0, max: 1.0 }], { maxEvaluations: opts.maxEvaluations ?? 90, tolerance: 1e-7 })
  const model: ShotModel = { ...start, efficiency: fit.x[0], backspin: fit.x[1] }
  const residuals = await shotResiduals(model, data)
  const after = rmsOf(residuals)
  // how much the error grows when one parameter is moved by a plausible amount: if it hardly does, the data does not determine that parameter
  const probe = (i: number, d: number): number => { const x = [...fit.x]; x[i] += d; return costOf(x) - after }
  const notes: string[] = []
  const weak = (name: string, i: number, d: number): void => {
    const g = Math.min(probe(i, d), probe(i, -d))
    if (g < Math.max(0.02, 0.5 * after)) notes.push(`${name} is weakly determined by these shots (moving it by ${d} changes the error by only ${g.toFixed(3)} m): add shots at other hood angles and flywheel speeds, and some measured at the HUB height`)
  }
  weak('efficiency', 0, 0.03)
  weak('backspin', 1, 0.1)
  return { model, fit, before: { rms: before }, after: { rms: after, residuals }, notes }
}
