// Physics worker: owns the engine and runs it against the wall clock at a chosen speed, posting frames at about 60 Hz.
// The engine itself never reads the clock; only this loop decides how many steps to run per tick.
import { Engine } from './engine'
import type { FromWorker, ToWorker } from './protocol'
import type { EngineSnapshot } from './types'
import { createTestGame, TEST_ROBOT } from '../games/test'
import { BridgeSession } from './bridge/session'
import { OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../robots/offseason'

let engine: Engine | null = null
let bridge: BridgeSession | null = null
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
  const st = bridge?.status
  post({
    type: 'frame', frame, running, speed, hasSnapshot: snapshot !== null, simRate,
    bridge: st && { connected: st.connected, frames: st.frames, robotTime: st.robotTime, skipped: st.skipped, robotEnabled: st.robotEnabled, hello: st.helloDevices },
  })
}

function tick(): void {
  const now = performance.now()
  const wall = (now - lastTick) / 1000
  lastTick = now
  if (engine && running && !bridge) {
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
  if ((running || bridge) && now - lastPost > 16) { lastPost = now; postFrame() }
}

async function handle(m: ToWorker): Promise<void> {
  try {
    switch (m.type) {
      case 'init': {
        bridge?.stop()
        bridge = null
        const game = createTestGame()
        const robot = m.mode === 'robot'
          ? { half: OFFSEASON_HALF, start: TEST_ROBOT.start, script: [], drivetrain: OFFSEASON_DRIVETRAIN }
          : TEST_ROBOT
        engine = await Engine.create({ game, robot, seed: m.seed })
        snapshot = null
        if (m.mode === 'robot') {
          bridge = new BridgeSession(engine, m.host ?? '127.0.0.1', 5810)
          bridge.start()
          running = true
        }
        post({ type: 'ready', gameId: game.id, field: game.field(), pieces: engine.pieceSpecs, robotHalf: robot.half, dt: engine.dt })
        postFrame()
        break
      }
      case 'run': running = m.running; budget = 0; if (bridge) bridge.paused = !m.running; postFrame(); break
      case 'ds': bridge?.setDs({ enabled: m.enabled, autonomous: m.autonomous, test: m.test }); break
      case 'joystick': bridge?.setJoystick(m.axes, BigInt(m.buttons), m.pov); break
      case 'speed': speed = m.value; postFrame(); break
      case 'step': if (engine && !bridge) { for (let i = 0; i < m.steps; i++) engine.step(); postFrame() } break
      case 'reset': if (engine) { engine.reset(m.seed); budget = 0; bridge?.seedPose(); postFrame() } break
      case 'save': if (engine) { snapshot = engine.snapshot(); postFrame() } break
      case 'load': if (engine && snapshot) { engine.restore(snapshot); budget = 0; bridge?.seedPose(); postFrame() } break
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message })
  }
}

// messages are handled strictly in order, also while the engine is still being created
let chain: Promise<void> = Promise.resolve()
self.onmessage = (ev: MessageEvent<ToWorker>) => { chain = chain.then(() => handle(ev.data)) }

setInterval(tick, 4)
