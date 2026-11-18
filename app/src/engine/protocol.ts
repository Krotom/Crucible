// Messages between the renderer and the physics worker.
import type { BatteryModel, Faults } from './bridge/faults'
import type { Detection, PoseEstimate, VisionSettings } from './vision'
import type { BreakSpec } from './breaks'
import type { TuneParams } from './tuning'
import type { FieldDefinition, PieceSpec, RenderFrame } from './types'

export type ToWorker =
  | { type: 'init'; seed: number; mode: 'script' | 'robot' | 'lockstep'; host?: string; game?: string; opponent?: 'none' | 'blocker' | 'cycler' | 'ally' | 'both'; stepDt?: number; alliance?: 'blue' | 'red'; start?: { x?: number; y?: number; yawDeg?: number }; tune?: TuneParams; faults?: Partial<Faults>; battery?: Partial<BatteryModel>; vision?: Partial<VisionSettings>; breaks?: Partial<BreakSpec> }
  | { type: 'match'; run: boolean }
  /** seconds >= 0 sets the lead by hand; a negative value turns the automatic lead (follow the measured round trip) back on */
  | { type: 'lead'; seconds: number }
  | { type: 'ds'; enabled: boolean; autonomous: boolean; test: boolean }
  | { type: 'joystick'; axes: number[]; buttons: number; pov: number }
  | { type: 'run'; running: boolean }
  | { type: 'speed'; value: number }
  | { type: 'step'; steps: number }
  | { type: 'reset'; seed?: number }
  /** change physical values live (see engine/tuning.ts: some apply from the next reset) */
  | { type: 'tune'; params: TuneParams }
  /** things that go wrong on a robot, and the battery that sags (robot-code modes) */
  | { type: 'faults'; faults: Partial<Faults> }
  /** pause the run when something happens (see breaks.ts) */
  | { type: 'breaks'; breaks: Partial<BreakSpec> }
  | { type: 'battery'; battery: Partial<BatteryModel> }
  /** the simulated AprilTag camera (robot-code modes) */
  | { type: 'vision'; vision: Partial<VisionSettings> }
  | { type: 'save'; slot?: number }
  | { type: 'load'; slot?: number }
  /** go back this many simulated seconds (scripted sims only: the robot program cannot be rewound) */
  | { type: 'rewind'; seconds: number }
  /** go back to this simulated time */
  | { type: 'seek'; time: number }

export interface WorkerReady {
  type: 'ready'
  gameId: string
  /** the game's status lines come with every frame */
  field: FieldDefinition
  pieces: PieceSpec[]
  robotHalf: [number, number, number]
  /** footprints of the other robots on the field, in the order of the frames' `others` */
  othersHalf: [number, number, number][]
  dt: number
  /** the match flow: phase names with their lengths in seconds (the last may be Infinity), for the timeline */
  phases: { name: string; duration: number }[]
}

/** Something that happened in the sim since the last frame, for the Analysis tab, the timeline and the event feed. */
export type UiEvent =
  | { t: number; kind: 'phase'; from: string | null; to: string }
  | { t: number; kind: 'launch'; id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; speed: number }
  | { t: number; kind: 'capture'; id: number }
  | { t: number; kind: 'impact'; against: 'field' | 'robot'; speed: number }
  | { t: number; kind: 'sensor'; sensor: string; alliance: 'blue' | 'red' | 'none'; x: number; y: number; id: number; enter: boolean }
  | { t: number; kind: 'score'; alliance: 'blue' | 'red' | 'none'; points: number; reason: string }

export interface VisionInfo { enabled: boolean; tags: Detection[]; pose: PoseEstimate | null; truth: { x: number; y: number; yaw: number } | null }

export interface BridgeInfo {
  connected: boolean
  frames: number
  robotTime: number
  skipped: number
  robotEnabled: boolean
  hello: string | null
  helloIssues: string[]
  rttMs: number
  leadMs: number
  components: Float64Array | null
  mechanisms: { name: string; position: number; velocity: number; volts: number; amps: number }[]
  /** the battery voltage the robot was last told and the current drawn */
  battery: { volts: number; amps: number }
  /** the simulated camera: what it sees now, the pose it reports, and where the robot really is */
  vision: VisionInfo
  fms: boolean
}

export type FromWorker =
  | WorkerReady
  | { type: 'frame'; frame: RenderFrame; running: boolean; speed: number; hasSnapshot: boolean; slots: boolean[]; canRewind: number; simRate: number; perf?: { stepMs: number; worstMs: number; dtMs: number }; bridge?: BridgeInfo; events: UiEvent[] }
  | { type: 'error'; message: string }
  /** a breakpoint stopped the run */
  | { type: 'paused'; reason: string; time: number }
