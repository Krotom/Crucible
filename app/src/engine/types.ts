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
  /** A convex solid given by its corner points (world coordinates) instead of a box, for ramps. center and half still bound it. */
  hull?: Vec3[]
  /** The robot body does not collide with it (the game's terrain() makes the robot climb it, see milestone M7) while pieces still collide with it. */
  robotPass?: boolean
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
  /** Start asleep (a piece at rest on the floor costs nothing until something touches it). */
  asleep?: boolean
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
  | { type: 'piece-launched'; spec: string; speed: number; position: Vec3; velocity: Vec3; pieceId: number }
  | { type: 'piece-entered-sensor'; sensor: SensorSpec; pieceId: number; spec: string }
  | { type: 'piece-left-sensor'; sensor: SensorSpec; pieceId: number; spec: string }
  | { type: 'phase-changed'; from: string | null; to: string }
  /** The robot was hit (or hit something): the speed change the contact caused, m/s, and what it touched. */
  | { type: 'robot-impact'; against: 'field' | 'robot'; speed: number }

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
  /** Puts a new piece into the world (for example FUEL coming out of a HUB). */
  spawn(s: PieceSpawn): number
  /** The robot: footprint center, heading, bumper half extents (x, y) and alliance. */
  robot: { x: number; y: number; yaw: number; half: [number, number]; alliance: Alliance }
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
  /** Called every engine step (rules that depend on time or robot position, timed respawns). */
  onTick?(ctx: GameContext): Score[]
  /** What the field system sends the robot as Game Data at this time (empty when nothing has been sent). */
  gameData?(state: Record<string, unknown>, time: number): string
  /** Short live values for the readout (which HUB is active, FUEL counts, fouls). */
  status?(state: Record<string, unknown>, time: number): Record<string, string>
  hud(): HudSpec
  /** Floor height at a field point, meters (BUMP ramps). The robot's tires follow it: the chassis tilts and slopes push back. */
  terrain?(x: number, y: number): number
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
  stages: { name: string; length: number; drivers: { driver: string; direction: 1 | -1; radius: number }[]; /** a hopper: the stage stores pieces in bulk (a drum or a bin) instead of in a single file; the roller before it fills it and its own drivers empty it onto the next stage one piece at a time */ hopper?: boolean }[]
  /** The most pieces the robot holds at once (a hopper stage makes room for them; without one the queue's length is the limit). */
  capacity?: number
  /** Pieces held at match start (the preload), queued at the front of the path. */
  preload?: number
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
    /** share of the flywheel's energy loss that ends up as the piece's kinetic energy (0 or absent: a shot does not slow the flywheel) */
    energyEfficiency?: number
  }
}

/** How the chassis touches the world (all optional; GUESS values until measured). */
export interface ChassisContact {
  /** yaw moment of inertia, kg*m^2 (default: a uniform plate) */
  moi?: number
  /** bumper friction and restitution (combined with the other surface: walls multiply, bumper against bumper averages) */
  friction?: number
  restitution?: number
  /** corner radius of the bumpers, approximated by a chamfer, meters */
  chamfer?: number
}

/** What a scripted robot does by itself (src/engine/bots.ts): follow a route, or cycle (pick up FUEL, drive to a firing spot, fire at its HUB). */
export interface BotAI {
  route?: { x: number; y: number }[]
  speed?: number
  cycle?: { pickup: { x: number; y: number }; at: { x: number; y: number }; intakeSeconds: number; count: number; rate: number; /** where the HUB is: x, y and the height to aim through */ target: Vec3; /** relative spread of speed and direction */ spread?: number }
}

/** Another robot on the field: a body that is pushed around and, with a script, drives (traction-limited like any robot). */
export interface OtherRobotSpec {
  name: string
  alliance: Alliance
  /** bumper footprint half extents and height */
  half: Vec3
  mass: number
  start: { x: number; y: number; yaw: number }
  /** tire-floor friction coefficient (the most the robot can push or resist with, times its weight; default 1.0) */
  mu?: number
  /** robot-relative driving; empty means the robot holds still (brakes) and can only be pushed */
  script?: ScriptSegment[]
  /** drives itself (overrides script) */
  ai?: BotAI
}

export interface RobotSpec {
  chassis?: ChassisContact
  /** other robots sharing the field (pushing, defense) */
  others?: OtherRobotSpec[]
  alliance?: Alliance
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

import type { PileOptions } from './pile'

/** Performance and accuracy knobs of the physics solver (see tests/bench.test.ts for how to measure them). All optional; the defaults are what the engine has always used. */
export interface EngineTuning {
  /** continuous collision detection for pieces: 'all' (default), 'none', 'fast' (only while a piece moves faster than fastSpeed) or 'soft' (predictive, cheaper) */
  ccd?: 'all' | 'none' | 'fast' | 'soft'
  /** speed above which 'fast' CCD is on, m/s (default 3) */
  fastSpeed?: number
  /** prediction distance for 'soft' CCD, meters (default 0.05) */
  softCcd?: number
  maxCcdSubsteps?: number
  /** Rapier's internal Gauss-Seidel iterations per solver iteration */
  pgsIterations?: number
  /** contact spring frequency (Hz) and allowed penetration / prediction distance, as fractions of the length unit */
  contactFrequency?: number
  allowedError?: number
  predictionDistance?: number
  /** freeze pieces at rest and thaw them near the robot or a moving piece (src/engine/pile.ts): a big pile no longer wakes as one island */
  pile?: PileOptions | true
}

export interface EngineConfig {
  tuning?: EngineTuning
  game: GameModule
  robot: RobotSpec
  seed: number
  /** Physics step in seconds (default 0.001). */
  dt?: number
  /** Rapier solver iterations (default 4); fewer is faster with many pieces in contact. */
  solverIterations?: number
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
  otherHandles?: number[]
  pile?: { rest: [number, number][] }
  botStates?: unknown[]
  contact?: { acc: number; quiet: number; peak: number; count: number; vx: number; vy: number; against: 'field' | 'robot' }
}

/** What the renderer needs each frame. */
export interface RenderFrame {
  time: number
  phase: string
  scores: Record<Alliance, number>
  /** [x, y, z, qw, qx, qy, qz] */
  robot: number[]
  robotSpeed: number
  /** other robots, [x, y, z, qw, qx, qy, qz] each */
  others: number[][]
  /** contact feedback: impacts so far and the speed change of the largest */
  impacts: { count: number; peak: number }
  pieceCount: number
  awakeCount: number
  /** x, y, z per piece. */
  piecePositions: Float32Array
  pieceSpecIndex: Uint8Array
  hash: string
  /** pieces inside the robot, their positions along the stage path (m from the intake mouth), and the beam breaks */
  held: number[]
  beams: boolean[]
  /** the game module's status lines */
  status: Record<string, string>
  /** the intake capture volume in the world (for drawing), null when there is no ball handling */
  capture: { center: Vec3; yaw: number; half: Vec3; active: boolean } | null
  shots: number
  captured: number
}
