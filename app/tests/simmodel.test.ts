import { describe, expect, it } from 'vitest'
import type { BridgeInfo } from '../src/engine/protocol'
import type { RenderFrame } from '../src/engine/types'
import { buildSimModel, phaseLabel } from '../src/renderer/src/lib/simmodel'

const frame = (over: Partial<RenderFrame> = {}): RenderFrame => ({
  time: 12.345, phase: 'shift1', scores: { blue: 12, red: 8 }, robot: [0, 0, 0, 1, 0, 0, 0], robotSpeed: 0, others: [],
  impacts: { count: 0, peak: 0 }, pieceCount: 408, awakeCount: 7, piecePositions: new Float32Array(0), pieceSpecIndex: new Uint8Array(0),
  status: { hubs: 'blue active   red INACTIVE', fuel: 'blue 12   red 8   (auto 5 / 3)', gameData: 'R', fouls: 'G403 0   G407 1', mystery: 'x' },
  hash: 'abc123', held: [1, 2], beams: [true, false, false], capture: { active: true } as RenderFrame['capture'], shots: 4, captured: 9,
  ...over,
} as RenderFrame)

const rowsOf = (m: ReturnType<typeof buildSimModel>, section: string) => m.sections.find((s) => s.id === section)?.rows ?? []
const value = (m: ReturnType<typeof buildSimModel>, section: string, id: string) => rowsOf(m, section).find((r) => r.id === id)

describe('sim panel model', () => {
  it('names the phases in plain words', () => {
    expect(phaseLabel('shift2')).toBe('Shift 2')
    expect(phaseLabel('ended')).toBe('Match over')
    expect(phaseLabel('none')).toBe('No match')
    expect(phaseLabel('sudden')).toBe('Sudden')
  })

  it('puts phase, clock and score in the header', () => {
    const m = buildSimModel(frame(), { running: true, simRate: 1.5, bridge: null })
    expect(m).toMatchObject({ phase: 'Shift 1', clock: '12.3 s', blue: 12, red: 8 })
  })

  it('labels the game values and flags an inactive HUB', () => {
    const m = buildSimModel(frame(), { running: true, simRate: 1, bridge: null })
    expect(value(m, 'game', 'hubs')).toMatchObject({ label: 'HUBs', value: 'blue active · red INACTIVE', tone: 'warn' })
    expect(value(m, 'game', 'fuel')?.value).toBe('blue 12 · red 8 (auto 5 / 3)')
    expect(value(m, 'game', 'mystery')?.label).toBe('Mystery')
    expect(value(m, 'game', 'gameData')?.hint).toMatch(/inactive first/)
  })

  it('describes the robot and the sim speed', () => {
    const m = buildSimModel(frame(), { running: false, simRate: 0, bridge: null })
    expect(value(m, 'match', 'speed')).toMatchObject({ value: 'Paused', tone: 'warn' })
    expect(value(m, 'robot', 'beams')?.value).toBe('● ○ ○')
    expect(value(m, 'robot', 'held')?.value).toBe('2 FUEL')
    expect(value(m, 'field', 'hits')?.value).toBe('none')
    expect(buildSimModel(frame({ capture: null }), { running: true, simRate: 1, bridge: null }).sections.some((s) => s.id === 'robot')).toBe(false)
  })

  it('shows the robot link, mechanisms and problems when robot code is connected', () => {
    const bridge = { connected: true, frames: 10, robotEnabled: true, rttMs: 1.234, leadMs: 0.5, helloIssues: ['no Pigeon'], mechanisms: [{ name: 'turret', position: 0.25, velocity: 1.5 }] } as unknown as BridgeInfo
    const m = buildSimModel(frame(), { running: true, simRate: 1, bridge })
    expect(value(m, 'link', 'link')).toMatchObject({ value: 'connected', tone: 'ok' })
    expect(value(m, 'link', 'enabled')?.value).toBe('enabled')
    expect(value(m, 'link', 'issue0')).toMatchObject({ value: 'no Pigeon', tone: 'bad' })
    expect(value(m, 'mech', 'turret')?.value).toBe('0.250 rot · 1.50 rps')
    const waiting = buildSimModel(frame(), { running: true, simRate: 1, bridge: { ...bridge, connected: false, frames: 0 } })
    expect(value(waiting, 'link', 'link')).toMatchObject({ value: 'waiting for it…', tone: 'warn' })
    expect(value(waiting, 'link', 'rtt')).toBeUndefined()
  })
})
