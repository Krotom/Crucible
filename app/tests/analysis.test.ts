import { afterEach, describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { BridgeSession } from '../src/engine/bridge/session'
import { encodeToApp } from '../src/engine/bridge/frames'
import { MSG_DS, MSG_HELLO, MSG_JOYSTICK, MSG_STEP, MSG_TO_APP } from '../src/engine/bridge/ws-transport'
import { createRebuiltGame } from '../src/games/rebuilt'
import { TEST_ROBOT } from '../src/games/test'
import { OFFSEASON, OFFSEASON_DRIVETRAIN, OFFSEASON_HALF } from '../src/robots/offseason'
import { botsToOthers, redCycler } from '../src/analysis/bots'
import { carryTimes, findBursts, Recorder, type Launch, type RunReport } from '../src/analysis/recorder'
import { comparisonTable, summaryLines, toHtml, toMarkdown } from '../src/analysis/report'
import { buttonMask, sticksToAxes, validateScript, type RunScript } from '../src/analysis/script'
import { executeScript } from '../src/analysis/runner'
import { FakeRobotWs } from './helpers/fake-ws-robot'

describe('script helpers', () => {
  it('maps sticks and buttons to the Xbox layout the robot code reads', () => {
    expect(sticksToAxes({ forward: 1, strafe: 0.5, rotate: -1, shoot: 1 })).toEqual([-0.5, -1, 0, 1, 1, 0])
    expect(sticksToAxes({})).toEqual([-0, -0, 0, 0, -0, 0])
    expect(buttonMask(['A'])).toBe(1n)
    expect(buttonMask(['A', 'X', 'RB'])).toBe(1n + 4n + 32n)
  })

  it('finds the problems in a script', () => {
    const bad: RunScript = { name: '', game: 'nope' as never, seed: 1, duration: -1, events: [{ t: 5, ds: 'enable' }, { t: 2, ds: 'disable' }] }
    const p = validateScript(bad).join(' | ')
    expect(p).toContain('name')
    expect(p).toContain('duration')
    expect(p).toContain('game')
    expect(p).toContain('out of order')
    expect(validateScript({ name: 'ok', game: 'test', seed: 1, duration: 10, events: [{ t: 1, ds: 'enable' }] })).toEqual([])
  })
})

describe('analytics', () => {
  const launch = (t: number, scored: boolean): Launch => ({ t, speed: 8, pieceId: Math.round(t * 10), x: 3, y: 4, scored, scoredAt: scored ? t + 1 : null })

  it('groups launches into bursts and measures cycles', () => {
    const l = [launch(5, true), launch(5.4, true), launch(5.8, false), launch(12, true), launch(12.5, true), launch(20, false)]
    const b = findBursts(l)
    expect(b.map((x) => [x.start, x.count, x.scored])).toEqual([[5, 3, 2], [12, 2, 2], [20, 1, 0]])
  })

  it('pairs pickups with launches first in, first out and skips the preload', () => {
    expect(carryTimes([2, 3, 4], [10, 11, 12])).toEqual([8, 8, 8])
    expect(carryTimes([2, 3], [1, 1.5, 10, 11], 2)).toEqual([8, 8]) // two preloaded shots first
    expect(carryTimes([], [1, 2])).toEqual([])
  })

  it('records a run of the engine: score timeline, driving, and the report text', async () => {
    const engine = await Engine.create({
      game: createRebuiltGame({ neutralFuel: 150, preload: 0 }),
      robot: { ...TEST_ROBOT, start: { x: 1.2, y: 1.0, yaw: 0 }, alliance: 'blue', others: botsToOthers([redCycler()]) },
      seed: 3, solverIterations: 2, dt: 0.005,
    })
    const rec = new Recorder(engine, { name: 'cycler', game: 'rebuilt', seed: 3, duration: 30, step: 0.005 })
    rec.attach()
    for (let i = 0; i < 300; i++) { engine.run(0.1); rec.sample() }
    const r = rec.report()
    rec.stop()
    expect(r.final.red).toBeGreaterThan(5)
    expect(r.scoreTimeline.length).toBeGreaterThan(2)
    expect(r.scoreTimeline.at(-1)![2]).toBe(r.final.red)
    expect(r.samples.length).toBe(300)
    const md = toMarkdown(r)
    expect(md).toContain('# cycler')
    expect(md).toContain(`red ${r.final.red}`)
    const html = toHtml(r)
    expect(html).toContain('<svg')
    expect(html).toContain('Score over time')
    expect(html).toContain('prefers-color-scheme')
    expect(summaryLines(r).length).toBeGreaterThan(5)
  }, 60_000)

  it('compares runs in a table', () => {
    const base = { name: 'a', game: 'rebuilt', seed: 1, duration: 10, step: 0.005, final: { blue: 12, red: 3 }, scoreTimeline: [], captures: [], launches: [], shots: 10, scoredShots: 6, accuracy: 0.6, bursts: [], cycleTimes: [8, 9], meanCycle: 8.5, carryTimes: [], distance: 30, maxSpeed: 4, maxZ: 0.12, hits: { count: 2, hardest: 1.4 }, enabledSeconds: 10, status: {}, samples: [] } satisfies RunReport
    const t = comparisonTable([base, { ...base, name: 'b', final: { blue: 20, red: 3 }, accuracy: 0.9 }])
    expect(t).toContain('| a | 12 | 3 | 10 | 6 | 60% |')
    expect(t).toContain('| b | 20 |')
  })
})

describe('executeScript against a fake lockstep robot', () => {
  let robot: FakeRobotWs | null = null
  let session: BridgeSession | null = null
  afterEach(() => { session?.stop(); robot?.stop(); session = null; robot = null })

  it('applies the script on the sim clock and reports the run', async () => {
    robot = new FakeRobotWs()
    await robot.start()
    robot.onConnect = () => robot!.send(MSG_HELLO, new TextEncoder().encode(JSON.stringify({ protocol: 0, modes: ['lockstep'], devices: [], mechanisms: [] })))
    const ids = [...OFFSEASON_DRIVETRAIN.modules.flatMap((m) => [m.driveId, m.steerId]), ...OFFSEASON.mechanisms.map((m) => m.id)]
    robot.onMessage = (m) => {
      if (m.type !== MSG_STEP) return
      const v = new DataView(m.body.buffer, m.body.byteOffset, m.body.byteLength)
      const seq = Number(v.getBigUint64(0, true))
      robot!.send(MSG_TO_APP, encodeToApp({ seq: BigInt(seq), simTime: seq * 0.005, batteryVolts: 12, flags: 1, motors: ids.map((id) => ({ id, appliedVolts: 0, flags: 0 })) }))
    }
    const script: RunScript = {
      name: 'fake', game: 'test', seed: 1, duration: 2, step: 0.005,
      events: [{ t: 0.5, ds: 'enable' }, { t: 1.0, sticks: { forward: 1 } }, { t: 1.2, buttons: ['A'] }, { t: 1.5, ds: 'disable' }],
    }
    const engine = await Engine.create({ game: (await import('../src/games/test')).createTestGame(), robot: { half: OFFSEASON_HALF, start: { x: 2, y: 1, yaw: 0 }, script: [], drivetrain: OFFSEASON_DRIVETRAIN, mechanisms: OFFSEASON.mechanisms }, seed: 1, dt: 0.005 })
    session = new BridgeSession(engine, '127.0.0.1', { ws: robot.port, nt: null }, () => {}, OFFSEASON, { dt: 0.005, speed: 0 })
    const report = await executeScript(engine, session, script, 20_000)
    expect(report.duration).toBe(2)
    expect(report.samples.length).toBe(21) // every 0.1 s from 0 to 2
    expect(engine.time).toBeCloseTo(2, 6)
    const log = robot.messages.filter((m) => m.type === MSG_DS || m.type === MSG_JOYSTICK || m.type === MSG_STEP).map((m) => (m.type === MSG_STEP ? 's' : m.type === MSG_DS ? 'd' : 'j'))
    const steps = (upTo: number): number => log.slice(0, upTo).filter((x) => x === 's').length
    // the sticks arrive after 1.0 s = 200 steps, the button after 240
    const firstJoy = log.findIndex((x, i) => x === 'j' && i > 4 && steps(i) > 100)
    expect(steps(firstJoy)).toBe(200)
  }, 30_000)

  it('refuses a script that does not validate', async () => {
    robot = new FakeRobotWs()
    await robot.start()
    const engine = await Engine.create({ game: (await import('../src/games/test')).createTestGame(), robot: TEST_ROBOT, seed: 1 })
    session = new BridgeSession(engine, '127.0.0.1', { ws: robot.port, nt: null }, () => {}, OFFSEASON, { dt: 0.005 })
    await expect(executeScript(engine, session, { name: 'x', game: 'test', seed: 1, duration: 0, events: [] })).rejects.toThrow(/duration/)
  })
})
