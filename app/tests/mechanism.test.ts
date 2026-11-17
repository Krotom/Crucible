import { describe, expect, it } from 'vitest'
import fixture from './fixtures/dcmotorsim.json'
import { MechanismModel } from '../src/engine/mechanism'
import { MOTORS } from '../src/engine/motors'
import { OFFSEASON } from '../src/robots/offseason'

const spec = (name: string) => OFFSEASON.mechanisms.find((m) => m.name === name)!

describe('mechanism model', () => {
  it('reaches the motor free speed through the gearbox with no load', () => {
    const hood = new MechanismModel(spec('hood'))
    for (let i = 0; i < 2000; i++) hood.step(0.001, 12)
    // WPILib's X44: Kv 68.19 rad/s per volt, so 12 V gives 818 rad/s = 130.2 rps at the rotor (the 7530 rpm spec is at the loaded nominal point)
    const rotorRps = (12 * 68.190139892) / (2 * Math.PI)
    expect(hood.motorState().rotorVelocityRps).toBeCloseTo(rotorRps, 2)
    expect(hood.rps).toBeCloseTo(rotorRps / 16.40625, 3)
  })

  it('follows the analytic first-order step response', () => {
    const s = spec('shooter') // three X60 on a 2:1 gearbox
    const m = new MechanismModel(s)
    // WPILib-style constants for 3 X60: Kt from stall torque and current, R divided by 3, Kv corrected for the 2 A free current
    const kt = 7.09 / 366
    const r = 12 / 366 / 3
    const ke = (12 - (12 / 366) * 2) / ((6000 * 2 * Math.PI) / 60)
    const g = s.gearRatio
    const tau = s.inertia / ((g * g * kt * ke) / r)
    const n = Math.round((tau * 2) / 0.001)
    const t = n * 0.001
    for (let i = 0; i < n; i++) m.step(0.001, 6)
    const wInf = 6 / (ke * g)
    expect(m.speed).toBeCloseTo(wInf * (1 - Math.exp(-t / tau)), 4)
  })

  it('stops dead against a hard stop and holds friction deadband', () => {
    const stop = new MechanismModel({ ...spec('hood'), limits: { min: 0, max: 0.5 } })
    for (let i = 0; i < 3000; i++) stop.step(0.001, 12)
    expect(stop.rotations).toBeCloseTo(0.5, 9)
    expect(stop.rps).toBe(0)
    for (let i = 0; i < 3000; i++) stop.step(0.001, -12)
    expect(stop.rotations).toBeCloseTo(0, 9)

    const sticky = new MechanismModel({ ...spec('turret'), frictionVolts: 0.5 })
    for (let i = 0; i < 500; i++) sticky.step(0.001, 0.4)
    expect(sticky.rotations).toBe(0) // below the friction voltage: no motion
    for (let i = 0; i < 500; i++) sticky.step(0.001, 1.0)
    expect(sticky.rotations).toBeGreaterThan(0)
  })

  it('rejects an unknown motor', () => {
    expect(() => new MechanismModel({ ...spec('hood'), motor: 'mystery' })).toThrow('Unknown motor')
  })
})

describe('against the robot\'s current physics (WPILib DCMotorSim, as TalonFXSim builds it)', () => {
  const ref = fixture as { motors: Record<string, { kt: number; kv: number; r: number }>; blockSeconds: number; volts: number[]; mechanisms: Record<string, { position: number[]; velocity: number[] }> }

  it("uses WPILib's motor constants", () => {
    for (const [name, c] of Object.entries(ref.motors)) {
      expect(MOTORS[name].kt).toBeCloseTo(c.kt, 8)
      expect(1 / MOTORS[name].ke).toBeCloseTo(c.kv, 6)
      expect(MOTORS[name].resistance).toBeCloseTo(c.r, 8)
    }
  })

  for (const name of Object.keys(ref.mechanisms)) {
    it(`${name}: position and velocity follow the same voltage profile`, () => {
      const m = new MechanismModel(spec(name))
      const steps = Math.round(ref.blockSeconds / 0.001)
      let worstPos = 0
      let worstVel = 0
      ref.volts.forEach((v, b) => {
        for (let k = 0; k < steps; k++) m.step(0.001, v)
        const p = ref.mechanisms[name].position[b]
        const w = ref.mechanisms[name].velocity[b]
        worstPos = Math.max(worstPos, Math.abs(m.rotations - p) / Math.max(1, Math.abs(p)))
        worstVel = Math.max(worstVel, Math.abs(m.rps - w) / Math.max(0.5, Math.abs(w)))
      })
      expect(worstPos).toBeLessThan(1e-6) // both integrate the same exact solution
      expect(worstVel).toBeLessThan(1e-6)
    })
  }
})
