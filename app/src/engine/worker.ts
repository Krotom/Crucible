// Physics worker: owns the engine and runs it against the wall clock at a chosen speed, posting frames at about 60 Hz.
// The engine itself never reads the clock; only this loop decides how many steps to run per tick.
import { Engine } from './engine'
import type { FromWorker, ToWorker, UiEvent } from './protocol'
import type { EngineSnapshot } from './types'
import { BridgeSession } from './bridge/session'
import { OFFSEASON } from '../robots/offseason'
import { buildSetup } from './setup'
import { cleanBattery, cleanFaults } from './bridge/faults'
import { anyBreak, cleanBreaks, matchBreak, NO_BREAKS } from './breaks'
import { cleanTune } from './tuning'

let frameCount = 0
let lastHash = ''
let pendingEvents: UiEvent[] = [] // what happened since the last frame
let hashedAt = -1 // sim time the cached hash belongs to
let forceHash = false // the next frame must carry a fresh hash (after a step, reset or load)
let engine: Engine | null = null
let bridge: BridgeSession | null = null
let breaks = { ...NO_BREAKS }
let breakTimeDone = false
const SLOTS = 3
let slots: (EngineSnapshot | null)[] = [null, null, null]
// a ring of snapshots every half second of sim time (the last minute): rewinding restores one and steps forward to the exact moment
const RING_EVERY = 0.5
const RING_MAX = 120
let ring: { time: number; snap: EngineSnapshot }[] = []
let running = false
let speed = 1
let budget = 0 // simulated seconds owed
let lastTick = performance.now()
let lastPost = 0
let rateWindow = { wall: performance.now(), sim: 0 }
let simRate = 0
let lastSimTime = 0

const post = (m: FromWorker): void => (self as unknown as Worker).postMessage(m)

/** Turns the engine's game events and score entries into the small records the page shows. */
function watchEngine(e: Engine): void {
  e.observe((ev, t) => {
    switch (ev.type) {
      case 'phase-changed': pendingEvents.push({ t, kind: 'phase', from: ev.from, to: ev.to }); break
      case 'piece-launched': pendingEvents.push({ t, kind: 'launch', id: ev.pieceId, x: ev.position[0], y: ev.position[1], z: ev.position[2], vx: ev.velocity[0], vy: ev.velocity[1], vz: ev.velocity[2], speed: ev.speed }); break
      case 'piece-captured': pendingEvents.push({ t, kind: 'capture', id: ev.pieceId }); break
      case 'robot-impact': pendingEvents.push({ t, kind: 'impact', against: ev.against, speed: ev.speed }); break
      case 'piece-entered-sensor': case 'piece-left-sensor':
        pendingEvents.push({ t, kind: 'sensor', sensor: ev.sensor.id, alliance: ev.sensor.alliance, x: ev.sensor.center[0], y: ev.sensor.center[1], id: ev.pieceId, enter: ev.type === 'piece-entered-sensor' }); break
    }
    if (pendingEvents.length > 5000) pendingEvents.splice(0, pendingEvents.length - 5000)
  })
  e.observeScores((s) => pendingEvents.push({ t: s.time, kind: 'score', alliance: s.alliance, points: s.points, reason: s.reason }))
}

const engineTime = (): number => engine?.time ?? 0

/** Keeps a snapshot when half a second of sim time has passed since the last one (not while the robot program drives the clock: it cannot be rewound). */
function remember(): void {
  if (!engine || bridge) return
  const last = ring[ring.length - 1]
  if (last && engine.time < last.time) ring = ring.filter((r) => r.time <= engine!.time)
  const keep = ring[ring.length - 1]
  if (!keep || engine.time - keep.time >= RING_EVERY - 1e-9) {
    ring.push({ time: engine.time, snap: engine.snapshot() })
    if (ring.length > RING_MAX) ring.shift()
  }
}

/** Goes back to simulated time `t` (not before the oldest snapshot): restores the latest snapshot at or before it and steps forward to the moment. */
function rewindTo(t: number): void {
  if (!engine || bridge || ring.length === 0) return
  let i = ring.length - 1
  while (i > 0 && ring[i].time > t + 1e-9) i--
  const entry = ring[i]
  engine.restore(entry.snap)
  ring = ring.slice(0, i + 1)
  const dt = engine.dt
  let n = 0
  while (engine.time + dt / 2 < t && n++ < Math.ceil(RING_EVERY / dt) + 2) engine.step()
  pendingEvents = []
  budget = 0
  forceHash = true
  postFrame()
}

/** Stops the run because a breakpoint matched: the sim pauses (also the robot's clock in the robot-code modes) and the page is told why. */
function pauseFor(reason: string): void {
  running = false
  budget = 0
  if (bridge) bridge.paused = true
  post({ type: 'paused', reason, time: engineTime() })
}

function postFrame(): void {
  // with robot code the robot's frames drive the sim, so breakpoints are checked here, once per frame, on what happened since the last one
  if (bridge && running && anyBreak(breaks) && engine) {
    const hit = matchBreak(pendingEvents, breaks, engine.time, breakTimeDone)
    if (hit) { breakTimeDone = hit.timeFired; pauseFor(hit.reason) }
  }
  if (!engine) return
  frameCount++
  // The hash walks every body, so while the sim runs it is refreshed only every 12th frame. Whenever the sim is paused or was just stepped,
  // reset or loaded, the shown hash must belong to the state shown next to it, so it is recomputed (only when something changed).
  const wantHash = forceHash || frameCount % 12 === 1 || (!running && engine.time !== hashedAt)
  const frame = engine.getFrame(wantHash)
  if (wantHash) { hashedAt = engine.time; forceHash = false }
  if (frame.hash) lastHash = frame.hash
  else frame.hash = lastHash
  const st = bridge?.status
  post({
    type: 'frame', frame, running, speed, hasSnapshot: slots.some((x) => x !== null), slots: slots.map((x) => x !== null), canRewind: bridge ? 0 : Math.max(0, engineTime() - (ring[0]?.time ?? engineTime())), simRate, events: pendingEvents.splice(0),
    bridge: st && {
      connected: st.connected, frames: st.frames, robotTime: st.robotTime, skipped: st.skipped, robotEnabled: st.robotEnabled, hello: st.helloDevices,
      helloIssues: st.helloIssues, components: st.components, fms: bridge?.fms ?? false, rttMs: (bridge?.rtt ?? 0) * 1000, leadMs: (bridge?.lead ?? 0) * 1000,
      mechanisms: [...(engine?.mechanisms.values() ?? [])].map((m) => ({ name: m.spec.name, position: m.rotations, velocity: m.rps, volts: bridge?.lastMotorVolts.get(m.spec.id) ?? 0, amps: m.supplyAmps })),
      battery: bridge?.batteryReading ?? { volts: 12, amps: 0 },
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
    const armed = anyBreak(breaks)
    let mark = pendingEvents.length
    while (budget >= dt && performance.now() - t0 < 12) {
      engine.step(); budget -= dt; n++
      if (armed) {
        const hit = matchBreak(pendingEvents.slice(mark), breaks, engine.time, breakTimeDone)
        if (hit) { breakTimeDone = hit.timeFired; pauseFor(hit.reason); postFrame(); break }
        mark = pendingEvents.length
      }
    }
    if (budget > 0.25) budget = 0 // fell behind: drop the backlog instead of spiraling
    rateWindow.sim += n * dt
    if (n > 0) remember()
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
        const setup = buildSetup(m)
        const lockstep = m.mode === 'lockstep'
        engine = await Engine.create({ ...setup.config, seed: m.seed })
        slots = [null, null, null]
        ring = []
        breaks = cleanBreaks(m.breaks)
        breakTimeDone = false
        pendingEvents = []
        watchEngine(engine)
        remember()
        if (m.mode !== 'script') {
          bridge = new BridgeSession(engine, m.host ?? '127.0.0.1', { ws: 5811, nt: lockstep ? null : 5810 }, () => {}, OFFSEASON, lockstep ? { dt: engine.dt, speed: speed } : null)
          bridge.faults = cleanFaults(m.faults)
          bridge.battery = cleanBattery(m.battery)
          bridge.start()
          running = true
        }
        post({ type: 'ready', gameId: setup.config.game.id, field: setup.config.game.field(), pieces: engine.pieceSpecs, robotHalf: setup.robotHalf, othersHalf: setup.othersHalf, dt: engine.dt, phases: setup.config.game.matchFlow().phases })
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
      case 'step': if (engine && !bridge) { for (let i = 0; i < m.steps; i++) engine.step(); remember(); forceHash = true; postFrame() } break
      case 'reset': if (engine) { engine.reset(m.seed); ring = []; remember(); breakTimeDone = breaks.time !== null && engine.time >= breaks.time; pendingEvents = []; budget = 0; bridge?.seedPose(); forceHash = true; postFrame() } break
      case 'save': if (engine) { slots[Math.min(SLOTS - 1, Math.max(0, m.slot ?? 0))] = engine.snapshot(); postFrame() } break
      case 'load': {
        const snap = slots[Math.min(SLOTS - 1, Math.max(0, m.slot ?? 0))]
        if (engine && snap) { engine.restore(snap); ring = ring.filter((r) => r.time <= engine!.time); remember(); breakTimeDone = breaks.time !== null && engine.time >= breaks.time; pendingEvents = []; budget = 0; bridge?.seedPose(); forceHash = true; postFrame() }
        break
      }
      case 'tune': if (engine) engine.tune(cleanTune(m.params)); break
      case 'breaks': breaks = cleanBreaks(m.breaks); breakTimeDone = breaks.time !== null && engineTime() >= breaks.time; break
      case 'faults': if (bridge) bridge.faults = cleanFaults(m.faults); break
      case 'battery': if (bridge) bridge.battery = cleanBattery(m.battery); break
      case 'rewind': if (engine && !bridge) rewindTo(Math.max(0, engine.time - Math.max(0, m.seconds))); break
      case 'seek': if (engine && !bridge && m.time < engine.time - 1e-9) rewindTo(Math.max(0, m.time)); break
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message })
  }
}

// messages are handled strictly in order, also while the engine is still being created
let chain: Promise<void> = Promise.resolve()
self.onmessage = (ev: MessageEvent<ToWorker>) => { chain = chain.then(() => handle(ev.data)) }

setInterval(tick, 4)
