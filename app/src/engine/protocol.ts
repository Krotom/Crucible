// Messages between the renderer and the physics worker.
import type { FieldDefinition, PieceSpec, RenderFrame } from './types'

export type ToWorker =
  | { type: 'init'; seed: number; mode: 'script' | 'robot'; host?: string }
  /** seconds >= 0 sets the lead by hand; a negative value turns the automatic lead (follow the measured round trip) back on */
  | { type: 'lead'; seconds: number }
  | { type: 'ds'; enabled: boolean; autonomous: boolean; test: boolean }
  | { type: 'joystick'; axes: number[]; buttons: number; pov: number }
  | { type: 'run'; running: boolean }
  | { type: 'speed'; value: number }
  | { type: 'step'; steps: number }
  | { type: 'reset'; seed?: number }
  | { type: 'save' }
  | { type: 'load' }

export interface WorkerReady {
  type: 'ready'
  gameId: string
  field: FieldDefinition
  pieces: PieceSpec[]
  robotHalf: [number, number, number]
  dt: number
}

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
  mechanisms: { name: string; position: number; velocity: number }[]
}

export type FromWorker =
  | WorkerReady
  | { type: 'frame'; frame: RenderFrame; running: boolean; speed: number; hasSnapshot: boolean; simRate: number; bridge?: BridgeInfo }
  | { type: 'error'; message: string }
