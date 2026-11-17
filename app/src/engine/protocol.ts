// Messages between the renderer and the physics worker.
import type { FieldDefinition, PieceSpec, RenderFrame } from './types'

export type ToWorker =
  | { type: 'init'; seed: number }
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

export type FromWorker =
  | WorkerReady
  | { type: 'frame'; frame: RenderFrame; running: boolean; speed: number; hasSnapshot: boolean; simRate: number }
  | { type: 'error'; message: string }
