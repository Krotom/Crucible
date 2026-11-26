import { describe, expect, it } from 'vitest'
import { PoseSmoother } from '../src/renderer/src/lib/livepose'
import { clock, hubStatus, matchElapsed, pickTopic } from '../src/renderer/src/lib/livehud'

describe('live view pose smoothing', () => {
  it('draws between the last two samples, one interval late', () => {
    const s = new PoseSmoother()
    s.push({ x: 0, y: 0, yaw: 0 }, 1.0)
    s.push({ x: 1, y: 0, yaw: 0 }, 1.05)
    s.push({ x: 2, y: 0, yaw: 0 }, 1.10)
    // the interval is about 0.05 s: at 1.125 the picture is at time 1.075, half way between the samples taken at 1.05 and 1.10
    const p = s.at(1.125)!
    expect(p.x).toBeGreaterThan(1.3); expect(p.x).toBeLessThan(1.7)
    expect(s.at(5)!.x).toBe(2) // no new data: it stays at the last pose
  })

  it('ignores repeats and snaps on a pose reset', () => {
    const s = new PoseSmoother()
    s.push({ x: 0, y: 0, yaw: 0 }, 1)
    s.push({ x: 0.1, y: 0, yaw: 0 }, 1.05)
    s.push({ x: 0.1, y: 0, yaw: 0 }, 1.10) // same pose again: not a new sample
    expect(s.at(1.2)!.x).toBeCloseTo(0.1)
    s.push({ x: 9, y: 4, yaw: 1 }, 1.15) // a jump of metres is a reset: no sliding across the field
    expect(s.at(1.15)).toEqual({ x: 9, y: 4, yaw: 1 })
  })

  it('turns the short way round at the yaw wrap', () => {
    const s = new PoseSmoother()
    s.push({ x: 0, y: 0, yaw: 3.1 }, 1)
    s.push({ x: 0.1, y: 0, yaw: -3.1 }, 1.05)
    const yaw = s.at(1.075)!.yaw // half way: close to pi, not to 0
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.1)
  })

  it('has nothing before the first sample', () => {
    expect(new PoseSmoother().at(1)).toBeNull()
  })
})

describe('live view readout', () => {
  it('maps the Driver Station match time to match seconds', () => {
    expect(matchElapsed('auto', 20)).toBe(0)
    expect(matchElapsed('auto', 5)).toBe(15)
    expect(matchElapsed('teleop', 140)).toBe(23) // AUTO and the 3 s scoring delay are behind
    expect(matchElapsed('teleop', 0)).toBe(163)
    expect(matchElapsed('disabled', 30)).toBeNull()
    expect(matchElapsed('teleop', null)).toBeNull()
  })

  it('knows which HUB is active in each period (manual 6.4.1)', () => {
    expect(hubStatus(5, '')).toMatchObject({ phase: 'auto', blue: true, red: true, known: true })
    // SHIFT 1 starts at 33 s: with 'R' the red HUB is inactive first
    expect(hubStatus(40, 'R')).toMatchObject({ phase: 'shift1', blue: true, red: false, known: true })
    expect(hubStatus(65, 'R')).toMatchObject({ phase: 'shift2', blue: false, red: true })
    expect(hubStatus(40, 'B')).toMatchObject({ phase: 'shift1', blue: false, red: true })
    expect(hubStatus(40, '').known).toBe(false) // no Game Data yet: a guess
    expect(hubStatus(150, 'R')).toMatchObject({ phase: 'endgame', blue: true, red: true })
    expect(hubStatus(40, 'R').untilChange).toBeCloseTo(18)
    expect(hubStatus(40, 'R').next).toBe('shift2')
    expect(hubStatus(999, 'R')).toMatchObject({ phase: 'ended', blue: false, red: false, untilChange: null })
  })

  it('finds topics by their tail and formats the clock', () => {
    const names = ['/Other/DriverStation/MatchTime', '/AdvantageKit/DriverStation/MatchTime', '/AdvantageKit/DriverStation/Enabled']
    expect(pickTopic(names, '/DriverStation/MatchTime')).toBe('/AdvantageKit/DriverStation/MatchTime')
    expect(pickTopic(names, '/Nope')).toBeUndefined()
    expect(clock(125.2)).toBe('2:06')
    expect(clock(null)).toBe('-:--')
  })
})
