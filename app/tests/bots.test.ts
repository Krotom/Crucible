import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { createRebuiltGame } from '../src/games/rebuilt'
import { TEST_ROBOT } from '../src/games/test'
import { blueAlly, botsToOthers, redCycler } from '../src/analysis/bots'
import type { BotScript } from '../src/analysis/script'
import type { EngineConfig } from '../src/engine/types'

async function world(bots: BotScript[], neutralFuel = 150, seed = 3, tuning?: EngineConfig['tuning']): Promise<Engine> {
  return Engine.create({ game: createRebuiltGame({ neutralFuel, preload: 0 }), robot: { ...TEST_ROBOT, start: { x: 1.2, y: 1.0, yaw: 0 }, alliance: 'blue', others: botsToOthers(bots) }, seed, solverIterations: 2, dt: 0.002, tuning })
}

describe('scripted bots', () => {
  it('follows a route through its waypoints and loops', async () => {
    const e = await world([{ name: 'p', alliance: 'red', start: { x: 14, y: 1, yaw: 0 }, speed: 2, route: [{ x: 14, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 1 }, { x: 14, y: 1 }] }], 0)
    const seen = new Set<string>()
    for (let i = 0; i < 15000; i++) {
      e.step()
      if (i % 250 === 0) {
        const [x, y] = e.getFrame().others[0]
        for (const [wx, wy] of [[14, 3], [15, 3], [15, 1], [14, 1]]) if (Math.hypot(x - wx, y - wy) < 0.4) seen.add(`${wx},${wy}`)
      }
    }
    expect(seen.size).toBe(4) // all four corners within 30 s: it drives the loop
  }, 60_000)

  it('a cycling robot takes FUEL from the neutral zone, fires it at its HUB and scores', async () => {
    const e = await world([redCycler()])
    const events: string[] = []
    e.run(40)
    expect(e.scoreTotals.red).toBeGreaterThan(8) // about 16 in 40 s
    expect(e.scoreTotals.blue).toBe(0)
    void events
  }, 60_000)

  it('with the pile frozen (as the app runs it) the cyclers still get through the pile and fire from inside their own ALLIANCE ZONE (G407)', async () => {
    // a frozen FUEL is a fixed body: a robot that is not the main one used to stop at the edge of the pile for good
    const e = await world([redCycler(), blueAlly()], 408, 3, { pile: true, ccd: 'fast' })
    // the bots' own state is internal to the engine: read it to see where each one stood when it fired
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrls = (e as any).others.map((o: any) => o.ctrl.state as { fired: number; taken: number })
    const fired = [0, 0]
    const spots: { k: number; x: number }[] = []
    for (let i = 0; i < 30 / 0.002; i++) {
      e.step()
      for (let k = 0; k < 2; k++) if (ctrls[k].fired > fired[k]) { fired[k] = ctrls[k].fired; spots.push({ k, x: e.getFrame(false).others[k][0] }) }
    }
    expect(fired[0]).toBeGreaterThanOrEqual(6) // red took FUEL out of the pile and fired a full load
    expect(fired[1]).toBeGreaterThanOrEqual(6)
    const FIELD = 16.54
    for (const s of spots) expect(s.k === 0 ? s.x >= FIELD - 4.028 : s.x <= 4.028, `bot ${s.k} fired from x ${s.x.toFixed(2)}, outside its alliance zone`).toBe(true)
  }, 90_000)

  it('repeats exactly and restores in the middle of a cycle', async () => {
    const a = await world([redCycler()])
    a.run(20)
    const snap = a.snapshot()
    a.run(10)
    const h = a.hash()
    const b = await world([redCycler()])
    b.run(30)
    expect(b.hash()).toBe(h)
    a.restore(snap)
    a.run(10)
    expect(a.hash()).toBe(h)
  }, 60_000)
})
