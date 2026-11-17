// Runs the physics engine in a worker and exposes it like the other data sources: frames for the 3D view, and a few
// topics pushed into the DataStore so the topic list and plots work for the simulation too.
import SimWorker from '../../../engine/worker?worker'
import type { BridgeInfo, FromWorker, ToWorker, WorkerReady } from '../../../engine/protocol'
import type { RenderFrame } from '../../../engine/types'
import type { DataStore } from './store'

const TOPIC_PERIOD = 0.05 // simulated seconds between samples pushed to the store

export class SimSource {
  private worker: Worker | null = null
  ready: WorkerReady | null = null
  latest: RenderFrame | null = null
  running = false
  speed = 1
  hasSnapshot = false
  simRate = 0
  bridge: BridgeInfo | null = null
  private lastPushed = -1
  private lastTime = 0

  constructor(private store: DataStore, private onReady: (r: WorkerReady) => void, private onError: (m: string) => void) {}

  get active(): boolean { return this.worker !== null }

  start(seed: number, mode: 'script' | 'robot' | 'lockstep' = 'script', host = '127.0.0.1', game: 'test' | 'rebuilt' = 'test', opponent = false, lockstepDt = 0.005): void {
    this.stop()
    this.store.startLive('Sim')
    this.lastPushed = -1
    this.lastTime = 0
    this.latest = null
    this.worker = new SimWorker()
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data)
    this.worker.onerror = (e) => this.onError(e.message)
    this.send({ type: 'init', seed, mode, host, game, opponent, lockstepDt })
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.latest = null
    this.running = false
  }

  send(m: ToWorker): void { this.worker?.postMessage(m) }

  private onMessage(m: FromWorker): void {
    if (m.type === 'ready') { this.ready = m; this.onReady(m); return }
    if (m.type === 'error') { this.onError(m.message); return }
    const f = m.frame
    this.latest = f
    this.running = m.running
    this.speed = m.speed
    this.hasSnapshot = m.hasSnapshot
    this.simRate = m.simRate
    this.bridge = m.bridge ?? null
    if (f.time < this.lastTime - 1e-9) { this.store.startLive('Sim'); this.lastPushed = -1 } // reset or state load: time went backwards
    this.lastTime = f.time
    if (f.time - this.lastPushed >= TOPIC_PERIOD - 1e-9) {
      this.lastPushed = f.time
      this.push(f)
    }
  }

  private push(f: RenderFrame): void {
    const t = f.time
    const s = this.store
    const [x, y, , qw, , , qz] = f.robot
    const yaw = 2 * Math.atan2(qz, qw)
    s.liveSeries('/Sim/Robot/Pose', 'struct:Pose2d').push(t, Float64Array.of(x, y, yaw))
    s.liveSeries('/Sim/Robot/Speed', 'double').push(t, f.robotSpeed)
    s.liveSeries('/Sim/Score/Blue', 'int').push(t, f.scores.blue)
    s.liveSeries('/Sim/Score/Red', 'int').push(t, f.scores.red)
    s.liveSeries('/Sim/Balls/Count', 'int').push(t, f.pieceCount)
    s.liveSeries('/Sim/Balls/Awake', 'int').push(t, f.awakeCount)
    s.liveSeries('/Sim/Balls/Held', 'int').push(t, f.held.length)
    s.liveSeries('/Sim/Balls/Shots', 'int').push(t, f.shots)
    f.beams.forEach((b, i) => s.liveSeries(`/Sim/Beam${i}`, 'boolean').push(t, b))
    s.liveSeries('/Sim/Phase', 'string').push(t, f.phase)
    s.touchLive(t)
  }
}
