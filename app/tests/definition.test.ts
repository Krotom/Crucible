import { describe, expect, it } from 'vitest'
import raw from '../robots/offseason/robot.yaml?raw'
import { checkAgainstHello, parseDefinition } from '../src/robots/definition'

const def = parseDefinition(raw)

/** What frc/robot/lib/simbridge/SimBridge.java publishes for this robot. */
function hello(over: { drop?: number[]; add?: number[]; ratio?: Record<number, number>; count?: Record<number, number> } = {}): string {
  const motors = [20, 21, 23, 24, 26, 27, 29, 30, ...def.mechanisms.map((m) => m.id)].filter((id) => !(over.drop ?? []).includes(id)).concat(over.add ?? [])
  return JSON.stringify({
    protocol: 0, name: 'OffSeason', modes: ['realtime'], exchangePeriodMs: 5,
    devices: [...motors.map((id) => ({ type: 'talonfx', id })), ...[22, 25, 28, 31].map((id) => ({ type: 'cancoder', id })), { type: 'pigeon2', id: 1 }],
    mechanisms: def.mechanisms.filter((m) => !(over.drop ?? []).includes(m.id)).map((m) => ({ id: m.id, motor: m.motor, count: over.count?.[m.id] ?? m.count, ratio: over.ratio?.[m.id] ?? m.gearRatio, inertia: m.inertia })),
  })
}

describe('robot definition', () => {
  it('loads the OffSeason definition', () => {
    expect(def.name).toBe('OffSeason')
    expect(def.drivetrain.modules).toHaveLength(4)
    expect(def.mechanisms.map((m) => m.name)).toEqual(['turret', 'shooter', 'feeder', 'indexer', 'hood', 'intakeDriver', 'intakeRoller'])
    expect(def.drivetrain.driveRatio).toBeCloseTo(7.03125)
    expect(def.mechanisms.find((m) => m.name === 'hood')!.motor).toBe('krakenX44')
  })

  it('reports readable errors for bad files', () => {
    expect(() => parseDefinition('robot: x\n')).toThrow('chassis must be a mapping')
    expect(() => parseDefinition(raw.replace('motor: krakenX44', 'motor: nope'))).toThrow('not a known motor')
    expect(() => parseDefinition(raw.replace('gearRatio: 46.5,', 'gearRatio: fast,'))).toThrow('gearRatio must be a number')
    expect(() => parseDefinition(raw.replace('id: 4,', 'id: 1,'))).toThrow('duplicate id 1')
  })

  it('agrees with a robot that registers exactly its devices', () => {
    expect(checkAgainstHello(def, hello())).toEqual([])
  })

  it('names every difference from the robot', () => {
    const issues = checkAgainstHello(def, hello({ drop: [7], add: [99], ratio: { 0: 50 }, count: { 1: 2 } }))
    expect(issues.join('\n')).toContain('does not register: 7')
    expect(issues.join('\n')).toContain('no model for (they will not move): 99')
    expect(issues.join('\n')).toContain('turret (id 0): robot gear ratio 50, definition says 46.5')
    expect(issues.join('\n')).toContain('shooter (id 1): robot has 2 x krakenX60, definition says 3 x krakenX60')
    expect(checkAgainstHello(def, 'not json')).toEqual(["the robot's Hello message is not valid JSON"])
  })
})
