// Types shared by the engine, game modules and the worker protocol. No DOM and no Rapier types here.
// Coordinates are WPILib field coordinates: X away from the blue wall, Y left, Z up; meters, radians, seconds.
import type { DrivetrainSpec } from './drivetrain'
import type { MechanismSpec } from './mechanism'

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
  /** Magnus lift from spin: C_L = min(max, gain * spin parameter), spin parameter = r * w / v. Omit for no lift. */
  magnus?: { gain: number; max: number }
  /** Foam: restitution multiplier by speed, piecewise linear [m/s, factor]; harder hits bounce less. Omit for a constant. */
  restitutionCurve?: [number, number][]
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
  | { type: 'piece-captured'; pieceId: number; spec: string }
  | { type: 'piece-launched'; spec: string; speed: number }
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

/**
 * How the robot takes in and shoots game pieces (the hybrid ball model): pieces outside the robot are rigid bodies; an intake
 * capture volume turns them into entries of a virtual queue that rides through the stages, and the shooter spawns a rigid body
 * with a computed launch state. Mechanism names refer to `RobotSpec.mechanisms`.
 */
export interface BallHandlingSpec {
  piece: string
  intake: {
    /** mechanism that slides the intake out (position in rotations), and the metres of travel per rotation and in total */
    driver: string
    metersPerRotation: number
    travel: number
    /** unit slide direction in the robot frame (forward and down) */
    slideAxis: Vec3
    /** the capture box with the intake fully out, robot frame (+X forward, Z from the floor) */
    openBox: { center: Vec3; half: Vec3 }
    /** captures only while the intake is at least this fraction out */
    minExtension: number
    roller: string
    rollerRadius: number
    /** sign of the roller speed that pulls pieces in */
    rollerDirection: 1 | -1
    minRollerRps: number
    /** pieces moving faster than this relative to the robot are not caught, m/s */
    maxRelativeSpeed: number
  }
  /**
   * Stages from the intake mouth to the shooter. A piece in a stage rides at the summed surface speed of the stage's drivers (a
   * stage can be moved by more than one roller: the intake roller while intaking, the indexer while shooting).
   */
  stages: { name: string; length: number; drivers: { driver: string; direction: 1 | -1; radius: number }[] }[]
  /** Beam breaks at positions along the stage path (m from the intake mouth); true while a piece overlaps them. */
  beams: { name: string; position: number }[]
  shooter: {
    turret: string
    hood: string
    flywheel: string
    /** turret axis in the robot frame, and where the piece leaves relative to it */
    axis: [number, number]
    exitForward: number
    exitHeight: number
    wheelRadius: number
    /** piece speed over flywheel surface speed (compression and slip) */
    efficiency: number
    elevationAtHoodZeroDeg: number
    hoodDegPerRotation: number
    /** spin parameter at launch (backspin), r * w / v */
    backspin: number
    /** the last stage must push at least this fast, m/s, and the flywheel must turn at least this fast, rps */
    minFeedSpeed: number
    minFlywheelRps: number
  }
}

export interface RobotSpec {
  balls?: BallHandlingSpec
  /** When set, the robot is a dynamic body driven by this swerve model (voltages in, forces out) instead of the script. */
  drivetrain?: DrivetrainSpec
  /** Rotary mechanisms driven by Talons, by CAN id (voltages in, rotor states out). */
  mechanisms?: MechanismSpec[]
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
  mechanisms?: Record<number, unknown>
  balls?: { held: number[]; shots: number; captured: number }
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
  /** pieces inside the robot, their positions along the stage path (m from the intake mouth), and the beam breaks */
  held: number[]
  beams: boolean[]
  /** the intake capture volume in the world (for drawing), null when there is no ball handling */
  capture: { center: Vec3; yaw: number; half: Vec3; active: boolean } | null
  shots: number
  captured: number
}
