// Types shared by the engine, game modules and the worker protocol. No DOM and no Rapier types here.
// Coordinates are WPILib field coordinates: X away from the blue wall, Y left, Z up; meters, radians, seconds.
import type { DrivetrainSpec } from './drivetrain'

export type Alliance = 'red' | 'blue' | 'none'
export type Vec3 = [number, number, number]

/** A static box in the field (walls, floor, field elements). Surface coefficients multiply with the piece's own. */
export interface BoxSpec {
  center: Vec3
  half: Vec3
  yaw?: number
  friction?: number
  restitution?: number
  /** For rendering and debugging. */
  label?: string
}

/** A region the engine watches for piece centers entering and leaving (goals, scoring zones, beam-break volumes). */
export interface SensorSpec {
  id: string
  center: Vec3
  half: Vec3
  yaw?: number
  alliance: Alliance
}

export interface FieldDefinition {
  length: number
  width: number
  colliders: BoxSpec[]
  sensors: SensorSpec[]
}

/** A kind of game piece. Surface coefficients are factors: they multiply with the surface they touch. */
export interface PieceSpec {
  id: string
  radius: number
  mass: number
  friction: number
  restitution: number
  /** Drag coefficient for quadratic air drag; 0 disables drag. */
  dragCoefficient: number
  /** Angular damping standing in for rolling resistance. */
  rollingDamping: number
  color: number
}

export interface PieceSpawn {
  spec: string
  position: Vec3
  velocity?: Vec3
  angularVelocity?: Vec3
}

export interface PhaseSpec {
  name: string
  /** Seconds; the last phase may use Infinity. */
  duration: number
}

export interface MatchFlowSpec {
  phases: PhaseSpec[]
}

export type GameEvent =
  | { type: 'piece-entered-sensor'; sensor: SensorSpec; pieceId: number; spec: string }
  | { type: 'piece-left-sensor'; sensor: SensorSpec; pieceId: number; spec: string }
  | { type: 'phase-changed'; from: string | null; to: string }

export interface Score {
  alliance: Alliance
  points: number
  reason: string
}

/** What a game module may do while handling an event. */
export interface GameContext {
  time: number
  phase: string
  rng: () => number
  /** Plain JSON state owned by the engine; saved and restored with snapshots. */
  state: Record<string, unknown>
  removePiece(id: number): void
}

export interface HudSpec {
  title: string
}

/** The engine never mentions a specific game: everything game-specific comes through this interface. */
export interface GameModule {
  id: string
  field(): FieldDefinition
  pieces(): PieceSpec[]
  initialLayout(rng: () => number): PieceSpawn[]
  matchFlow(): MatchFlowSpec
  onEvent(e: GameEvent, ctx: GameContext): Score[]
  hud(): HudSpec
}

/** One segment of scripted driving, robot-relative: forward and left in m/s, counterclockwise in rad/s. */
export interface ScriptSegment {
  duration: number
  vx: number
  vy: number
  omega: number
}

export interface RobotSpec {
  /** When set, the robot is a dynamic body driven by this swerve model (voltages in, forces out) instead of the script. */
  drivetrain?: DrivetrainSpec
  /** Bumper footprint half extents and height of the collider, meters. */
  half: Vec3
  start: { x: number; y: number; yaw: number }
  script: ScriptSegment[]
}

export interface EngineConfig {
  game: GameModule
  robot: RobotSpec
  seed: number
  /** Physics step in seconds (default 0.001). */
  dt?: number
}

export interface ScoreEntry extends Score {
  time: number
}

/** Everything needed to restore an engine bit for bit. */
export interface EngineSnapshot {
  version: 1
  world: Uint8Array
  time: number
  stepCount: number
  rng: number
  nextPieceId: number
  pieces: { id: number; spec: string; handle: number }[]
  robotHandle: number
  sensorInside: Record<string, number[]>
  scores: Record<Alliance, number>
  scoreLog: ScoreEntry[]
  phaseIndex: number
  gameState: Record<string, unknown>
  drivetrain?: unknown
}

/** What the renderer needs each frame. */
export interface RenderFrame {
  time: number
  phase: string
  scores: Record<Alliance, number>
  /** [x, y, z, qw, qx, qy, qz] */
  robot: number[]
  robotSpeed: number
  pieceCount: number
  awakeCount: number
  /** x, y, z per piece. */
  piecePositions: Float32Array
  pieceSpecIndex: Uint8Array
  hash: string
}
