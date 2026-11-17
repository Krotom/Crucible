// Physics worker: owns the engine and runs it against the wall clock at a chosen speed, posting frames at about 60 Hz.
// The engine itself never reads the clock; only this loop decides how many steps to run per tick.
import { Engine } from './engine'
import { botsToOthers, redCycler } from '../analysis/bots'
import type { FromWorker, ToWorker } from './protocol'
import type { EngineSnapshot } from './types'
import { createRebuiltGame } from '../games/rebuilt'
import { createTestGame, TEST_ROBOT } from '../games/test'
import { BridgeSession } from './bridge/session'
import { OFFSEASON } from '../robots/offseason'

let frameCount = 0
let lastHash = ''
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
let lastSimTime = 0

const post = (m: FromWorker): void => (self as unknown as Worker).postMessage(m)

function postFrame(): void {
  if (!engine) return
  frameCount++
  const frame = engine.getFrame(frameCount % 12 === 1)
  if (frame.hash) lastHash = frame.hash
  else frame.hash = lastHash
  const st = bridge?.status
  post({
    type: 'frame', frame, running, speed, hasSnapshot: snapshot !== null, simRate,
    bridge: st && {
      connected: st.connected, frames: st.frames, robotTime: st.robotTime, skipped: st.skipped, robotEnabled: st.robotEnabled, hello: st.helloDevices,
      helloIssues: st.helloIssues, components: st.components, fms: bridge?.fms ?? false, rttMs: (bridge?.rtt ?? 0) * 1000, leadMs: (bridge?.lead ?? 0) * 1000,
      mechanisms: [...(engine?.mechanisms.values() ?? [])].map((m) => ({ name: m.spec.name, position: m.rotations, velocity: m.rps })),
    },
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
  if (engine && bridge) { rateWindow.sim += Math.max(0, engine.time - lastSimTime); lastSimTime = engine.time } // the robot drives the clock: measure how fast it runs
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
        const rebuilt = m.game === 'rebuilt'
        // REBUILT: the manual's 408 FUEL in the neutral zone. A pile of that size stays real time because resting FUEL is frozen (src/engine/pile.ts),
        // CCD runs only on fast pieces, 2 solver iterations, and a 2 ms step by default; see rules/REBUILT_RULES_EXTRACT.md section 7
        const game = rebuilt ? createRebuiltGame({ preload: OFFSEASON.balls?.preload ?? 0, neutralFuel: 408 }) : createTestGame()
        const start = rebuilt ? { x: 1.6, y: 4.0, yaw: 0 } : OFFSEASON.start
        // an opponent robot that holds still at the center line: something to push against and to be blocked by
        const others = m.opponent === 'cycler' ? botsToOthers([redCycler()]) : m.opponent === 'blocker' ? [{ name: 'opponent', alliance: 'red' as const, half: [0.43, 0.43, 0.12] as [number, number, number], mass: 55, start: { x: rebuilt ? 6.5 : 3, y: rebuilt ? 4.0 : 0, yaw: Math.PI } }] : []
        const robot = m.mode !== 'script'
          ? { half: OFFSEASON.bumper, start, script: [], drivetrain: OFFSEASON.drivetrain, mechanisms: OFFSEASON.mechanisms, balls: OFFSEASON.balls, alliance: 'blue' as const, chassis: OFFSEASON.contact, others }
          : rebuilt ? { ...TEST_ROBOT, start, alliance: 'blue' as const, others } : { ...TEST_ROBOT, others }
        const lockstep = m.mode === 'lockstep'
        // the physics step: larger is faster and coarser (REBUILT with 408 FUEL: 1 ms about 0.9x, 2 ms 1.6x, 5 ms 4x real time while plowing the whole pile); in lockstep one exchange is one step
        engine = await Engine.create({ game, robot, seed: m.seed, solverIterations: rebuilt ? 2 : undefined, dt: m.stepDt ?? 0.002, tuning: rebuilt ? { pile: true, ccd: 'fast' } : undefined })
        snapshot = null
        if (m.mode !== 'script') {
          bridge = new BridgeSession(engine, m.host ?? '127.0.0.1', { ws: 5811, nt: lockstep ? null : 5810 }, () => {}, OFFSEASON, lockstep ? { dt: engine.dt, speed: speed } : null)
          bridge.start()
          running = true
        }
        post({ type: 'ready', gameId: game.id, field: game.field(), pieces: engine.pieceSpecs, robotHalf: robot.half, othersHalf: others.map((o) => o.half), dt: engine.dt })
        postFrame()
        break
      }
      case 'run': running = m.running; budget = 0; if (bridge) bridge.paused = !m.running; postFrame(); break
      case 'match':
        if (engine && bridge) {
          if (m.run) { engine.reset(); budget = 0; bridge.seedPose(); bridge.startMatch() } else bridge.endMatch()
          postFrame()
        }
        break
      case 'lead': if (bridge) { bridge.autoLead = m.seconds < 0; if (m.seconds >= 0) bridge.lead = m.seconds } break
      case 'ds': bridge?.setDs({ enabled: m.enabled, autonomous: m.autonomous, test: m.test }); break
      case 'joystick': bridge?.setJoystick(m.axes, BigInt(m.buttons), m.pov); break
      case 'speed': speed = m.value; if (bridge?.isLockstep) bridge.speed = m.value; postFrame(); break
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
