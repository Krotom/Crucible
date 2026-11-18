// Built-in test scenarios for robot code: a scripted driver (stick and button inputs at given sim times) and checks on where the robot ends up.
// The runner is a pure state machine fed with what happened (sim time, robot pose, connection) and answering with what to send; the page does the sending.
export interface Pose { x: number; y: number; yaw: number; z: number }

export interface DriverState {
  enabled: boolean
  autonomous: boolean
  /** axes 0 LX, 1 LY (up is negative), 2 LT, 3 RT, 4 RX, 5 RY */
  axes: number[]
  buttons: number
}

export interface Step { at: number; set: Partial<DriverState> }
export interface CheckResult { label: string; value: string; need: string; ok: boolean }
export interface Scenario {
  id: string
  name: string
  description: string
  game: 'test' | 'rebuilt'
  start?: { x: number; y: number; yawDeg: number }
  steps: Step[]
  /** sim seconds after which the scenario ends (the last step is before this) */
  duration: number
  /** the checks, from the pose at the start, at the end and the highest the robot rose */
  check: (a: { start: Pose; end: Pose; maxZ: number; minZ: number }) => CheckResult[]
}

const NEUTRAL: DriverState = { enabled: false, autonomous: false, axes: [0, 0, 0, 0, 0, 0], buttons: 0 }
const stick = (axes: Partial<Record<'lx' | 'ly' | 'rx', number>>): number[] => [axes.lx ?? 0, axes.ly ?? 0, 0, 0, axes.rx ?? 0, 0]
const f = (v: number, d = 2): string => v.toFixed(d)
const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }

/** Distance moved along the start heading, sideways (left positive), and the heading change in degrees. */
export function motion(start: Pose, end: Pose): { forward: number; left: number; turnDeg: number; moved: number } {
  const dx = end.x - start.x, dy = end.y - start.y
  const c = Math.cos(start.yaw), s = Math.sin(start.yaw)
  return { forward: dx * c + dy * s, left: -dx * s + dy * c, turnDeg: (wrap(end.yaw - start.yaw) * 180) / Math.PI, moved: Math.hypot(dx, dy) }
}

const ok = (label: string, value: number, unit: string, need: string, pass: boolean): CheckResult => ({ label, value: `${f(value)} ${unit}`, need, ok: pass })

export const SCENARIOS: Scenario[] = [
  {
    id: 'forward', name: 'Drive forward', game: 'rebuilt', duration: 4.5,
    description: 'Enabled in teleop, the left stick pushed fully forward for 2 s, then released.',
    steps: [{ at: 0.5, set: { enabled: true } }, { at: 1, set: { axes: stick({ ly: -1 }) } }, { at: 3, set: { axes: stick({}) } }],
    check: ({ start, end }) => { const m = motion(start, end); return [ok('moved forward', m.forward, 'm', 'at least 1.5 m', m.forward >= 1.5), ok('drift sideways', Math.abs(m.left), 'm', 'at most 0.3 m', Math.abs(m.left) <= 0.3), ok('heading change', Math.abs(m.turnDeg), '°', 'at most 8°', Math.abs(m.turnDeg) <= 8)] },
  },
  {
    id: 'strafe', name: 'Strafe left', game: 'rebuilt', duration: 4,
    description: 'The left stick pushed fully left for 1.5 s: a swerve should slide sideways without turning.',
    steps: [{ at: 0.5, set: { enabled: true } }, { at: 1, set: { axes: stick({ lx: -1 }) } }, { at: 2.5, set: { axes: stick({}) } }],
    check: ({ start, end }) => { const m = motion(start, end); return [ok('moved left', m.left, 'm', 'at least 0.8 m', m.left >= 0.8), ok('drift forward', Math.abs(m.forward), 'm', 'at most 0.3 m', Math.abs(m.forward) <= 0.3), ok('heading change', Math.abs(m.turnDeg), '°', 'at most 8°', Math.abs(m.turnDeg) <= 8)] },
  },
  {
    id: 'spin', name: 'Spin in place', game: 'rebuilt', duration: 5,
    description: 'The right stick pushed fully right for 2 s: the robot should turn on the spot.',
    steps: [{ at: 0.5, set: { enabled: true } }, { at: 1, set: { axes: stick({ rx: 1 }) } }, { at: 3, set: { axes: stick({}) } }],
    check: ({ start, end }) => { const m = motion(start, end); return [ok('turned', Math.abs(m.turnDeg), '°', 'at least 90°', Math.abs(m.turnDeg) >= 90), ok('wandered off', m.moved, 'm', 'at most 0.4 m', m.moved <= 0.4)] },
  },
  {
    id: 'bump', name: 'Climb the BUMP', game: 'rebuilt', duration: 5.5, start: { x: 2.4, y: 2.51, yawDeg: 0 },
    description: 'Starts in front of a BUMP and drives straight over it: the chassis should rise and come back down.',
    steps: [{ at: 0.5, set: { enabled: true } }, { at: 1, set: { axes: stick({ ly: -1 }) } }, { at: 4, set: { axes: stick({}) } }],
    check: ({ start, end, maxZ }) => { const m = motion(start, end); return [ok('rose over the BUMP', maxZ - start.z, 'm', 'at least 0.05 m', maxZ - start.z >= 0.05), ok('got past it', m.forward, 'm', 'at least 2.5 m', m.forward >= 2.5)] },
  },
]

export type RunPhase = 'waiting' | 'running' | 'done' | 'failed'
export interface RunSnapshot { simTime: number; pose: Pose; connected: boolean }
export interface RunOutput { driver: DriverState | null; phase: RunPhase }

/** One scenario being played: waits for the robot to connect, then plays the steps by sim time and judges the end. */
export class ScenarioRun {
  phase: RunPhase = 'waiting'
  driver: DriverState = { ...NEUTRAL }
  results: CheckResult[] = []
  error = ''
  private t0 = 0
  private start: Pose | null = null
  private maxZ = -Infinity
  private minZ = Infinity
  private next = 0

  /** @param waitSeconds how long to wait for the robot program to connect (wall seconds are counted by the caller through `fail`) */
  constructor(readonly scenario: Scenario) {}

  fail(message: string): void { this.phase = 'failed'; this.error = message }

  /** Feeds one frame; returns the driver state to send when it changed (and null otherwise). */
  update(s: RunSnapshot): RunOutput {
    if (this.phase === 'done' || this.phase === 'failed') return { driver: null, phase: this.phase }
    let changed: DriverState | null = null
    if (this.phase === 'waiting') {
      if (!s.connected) return { driver: null, phase: this.phase }
      this.phase = 'running'; this.t0 = s.simTime; this.start = { ...s.pose }; this.next = 0
      changed = { ...NEUTRAL }; this.driver = changed
    }
    this.maxZ = Math.max(this.maxZ, s.pose.z); this.minZ = Math.min(this.minZ, s.pose.z)
    const t = s.simTime - this.t0
    while (this.next < this.scenario.steps.length && this.scenario.steps[this.next].at <= t + 1e-9) {
      const step = this.scenario.steps[this.next++]
      this.driver = { ...this.driver, ...step.set, axes: step.set.axes ? [...step.set.axes] : this.driver.axes }
      changed = this.driver
    }
    if (t >= this.scenario.duration) {
      this.phase = 'done'
      this.results = this.scenario.check({ start: this.start!, end: { ...s.pose }, maxZ: this.maxZ, minZ: this.minZ })
      this.driver = { ...NEUTRAL }
      return { driver: this.driver, phase: 'done' }
    }
    return { driver: changed, phase: this.phase }
  }

  get passed(): boolean { return this.phase === 'done' && this.results.length > 0 && this.results.every((r) => r.ok) }
}
