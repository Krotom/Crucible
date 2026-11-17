// Physics worker: owns the engine and runs it against the wall clock at a chosen speed, posting frames at about 60 Hz.
// The engine itself never reads the clock; only this loop decides how many steps to run per tick.
import { Engine } from './engine'
import type { FromWorker, ToWorker } from './protocol'
import type { EngineSnapshot } from './types'
import { createTestGame, TEST_ROBOT } from '../games/test'

let engine: Engine | null = null
let snapshot: EngineSnapshot | null = null
let running = false
let speed = 1
let budget = 0 // simulated seconds owed
let lastTick = performance.now()
let lastPost = 0
let rateWindow = { wall: performance.now(), sim: 0 }
let simRate = 0

const post = (m: FromWorker): void => (self as unknown as Worker).postMessage(m)

function postFrame(): void {
  if (!engine) return
  const frame = engine.getFrame()
  post({ type: 'frame', frame, running, speed, hasSnapshot: snapshot !== null, simRate })
}

function tick(): void {
  const now = performance.now()
  const wall = (now - lastTick) / 1000
  lastTick = now
  if (engine && running) {
    budget += Math.min(wall, 0.1) * speed
    const dt = engine.dt
    const t0 = performance.now()
    let n = 0
    // never spend more than ~12 ms of a tick stepping, so the loop stays responsive when the load is high
    while (budget >= dt && performance.now() - t0 < 12) { engine.step(); budget -= dt; n++ }
    if (budget > 0.25) budget = 0 // fell behind: drop the backlog instead of spiraling
    rateWindow.sim += n * dt
  }
  if (now - rateWindow.wall > 500) {
    simRate = rateWindow.sim / ((now - rateWindow.wall) / 1000)
    rateWindow = { wall: now, sim: 0 }
  }
  if (running && now - lastPost > 16) { lastPost = now; postFrame() }
}

async function handle(m: ToWorker): Promise<void> {
  try {
    switch (m.type) {
      case 'init': {
        const game = createTestGame()
        engine = await Engine.create({ game, robot: TEST_ROBOT, seed: m.seed })
        snapshot = null
        post({
          type: 'ready', gameId: game.id, field: game.field(), pieces: engine.pieceSpecs, robotHalf: TEST_ROBOT.half, dt: engine.dt,
        })
        postFrame()
        break
      }
      case 'run': running = m.running; budget = 0; postFrame(); break
      case 'speed': speed = m.value; postFrame(); break
      case 'step': if (engine) { for (let i = 0; i < m.steps; i++) engine.step(); postFrame() } break
      case 'reset': if (engine) { engine.reset(m.seed); budget = 0; postFrame() } break
      case 'save': if (engine) { snapshot = engine.snapshot(); postFrame() } break
      case 'load': if (engine && snapshot) { engine.restore(snapshot); budget = 0; postFrame() } break
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message })
  }
}

// messages are handled strictly in order, also while the engine is still being created
let chain: Promise<void> = Promise.resolve()
self.onmessage = (ev: MessageEvent<ToWorker>) => { chain = chain.then(() => handle(ev.data)) }

setInterval(tick, 4)
