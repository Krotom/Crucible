import { describe, expect, it } from 'vitest'
import { motion, ScenarioRun, SCENARIOS, type Pose } from '../src/renderer/src/lib/scenarios'

const pose = (x: number, y: number, yawDeg = 0, z = 0.12): Pose => ({ x, y, yaw: (yawDeg * Math.PI) / 180, z })

describe('motion relative to the start heading', () => {
  it('splits a move into forward and left along the heading the robot started with', () => {
    expect(motion(pose(1, 1, 0), pose(3, 1.5, 0))).toMatchObject({ forward: 2, left: 0.5 })
    const m = motion(pose(1, 1, 90), pose(1, 3, 90)); expect(m.forward).toBeCloseTo(2); expect(m.left).toBeCloseTo(0, 6) // facing +y: forward is +y
    expect(motion(pose(0, 0, 0), pose(0, 0, 350)).turnDeg).toBeCloseTo(-10); expect(motion(pose(0, 0, 170), pose(0, 0, -170)).turnDeg).toBeCloseTo(20) // across the wrap
  })
})

describe('scenario definitions', () => {
  it('have unique ids, steps in time order inside the duration, and the robot is disabled and still at the end', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) {
      expect(s.steps.every((st, i) => i === 0 || st.at >= s.steps[i - 1].at), s.id + ' steps in order').toBe(true); expect(s.steps.at(-1)!.at).toBeLessThan(s.duration)
      expect(s.steps.some((st) => st.set.enabled), s.id + ' enables the robot').toBe(true); expect(s.description.length).toBeGreaterThan(20)
    }
  })
})

/** Plays a scenario against a simulated robot that moves as `move(t)` says (poses relative to the start). */
function play(id: string, move: (t: number) => Pose, connectAt = 0): ScenarioRun {
  const run = new ScenarioRun(SCENARIOS.find((s) => s.id === id)!)
  for (let t = 0; t < 12; t += 0.02) {
    const out = run.update({ simTime: t, pose: move(Math.max(0, t - connectAt)), connected: t >= connectAt })
    if (out.phase === 'done') break
  }
  return run
}

describe('playing a scenario', () => {
  it('waits for the connection, then drives the stick by sim time and passes a robot that does what it should', () => {
    const run = new ScenarioRun(SCENARIOS[0])
    expect(run.update({ simTime: 0, pose: pose(1.6, 4), connected: false })).toEqual({ driver: null, phase: 'waiting' })
    expect(run.update({ simTime: 5, pose: pose(1.6, 4), connected: true }).driver).toEqual({ enabled: false, autonomous: false, axes: [0, 0, 0, 0, 0, 0], buttons: 0 }) // starts disabled, still
    const seen: { t: number; enabled: boolean; ly: number }[] = []
    for (let t = 5; t < 12; t += 0.02) {
      const tt = t - 5
      const out = run.update({ simTime: t, pose: pose(1.6 + Math.max(0, tt - 1) * 1.2, 4), connected: true })
      if (out.driver) seen.push({ t: +tt.toFixed(1), enabled: out.driver.enabled, ly: out.driver.axes[1] })
      if (out.phase === 'done') break
    }
    expect(seen.map((s) => [s.t, s.enabled, s.ly])).toEqual([[0.5, true, 0], [1, true, -1], [3, true, 0], [4.5, false, 0]])
    expect(run.passed).toBe(true); expect(run.results.map((r) => r.label)).toEqual(['moved forward', 'drift sideways', 'heading change'])
  })
  it('fails a robot that does not move, drifts sideways or turns, naming the failed check', () => {
    expect(play('forward', () => pose(1.6, 4)).results.filter((r) => !r.ok).map((r) => r.label)).toEqual(['moved forward'])
    const drift = play('forward', (t) => pose(1.6 + t * 0.8, 4 + t * 0.4)); expect(drift.passed).toBe(false); expect(drift.results.find((r) => r.label === 'drift sideways')!.ok).toBe(false)
    const turn = play('forward', (t) => pose(1.6 + t * 0.8, 4, t * 10)); expect(turn.results.find((r) => r.label === 'heading change')!.ok).toBe(false)
  })
  it('judges strafe, spin and the BUMP climb on the right quantities', () => {
    expect(play('strafe', (t) => pose(1.6, 4 + Math.max(0, t - 1) * 1)).passed).toBe(true); expect(play('strafe', (t) => pose(1.6 + Math.max(0, t - 1), 4)).passed).toBe(false)
    expect(play('spin', (t) => pose(1.6, 4, Math.max(0, t - 1) * 60)).passed).toBe(true); expect(play('spin', (t) => pose(1.6 + t * 0.3, 4, Math.max(0, t - 1) * 60)).passed).toBe(false)
    const climb = play('bump', (t) => pose(2.4 + Math.max(0, t - 1) * 1.4, 2.51, 0, t > 2 && t < 3.5 ? 0.12 + 0.1 : 0.12)); expect(climb.passed).toBe(true)
    expect(play('bump', (t) => pose(2.4 + Math.max(0, t - 1) * 1.4, 2.51)).results.find((r) => r.label === 'rose over the BUMP')!.ok).toBe(false)
  })
  it('stays failed when told so (connection never came) and ignores later frames; results are empty until done', () => {
    const run = new ScenarioRun(SCENARIOS[0]); run.fail('the robot program did not connect'); expect(run.update({ simTime: 1, pose: pose(0, 0), connected: true })).toEqual({ driver: null, phase: 'failed' }); expect(run.error).toContain('did not connect'); expect(run.passed).toBe(false)
    const r2 = new ScenarioRun(SCENARIOS[0]); expect(r2.passed).toBe(false); expect(r2.results).toEqual([])
  })
})
