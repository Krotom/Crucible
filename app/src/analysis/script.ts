// A run script: what the driver does and when, in simulated time, so the same script on the same robot code gives the same run (lockstep, Mode B).
// Scripts are plain JSON. Times are seconds of simulated time since the run started.
import type { BridgeSession } from '../engine/bridge/session'

export type Button = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB'

/** Driver sticks and triggers, each -1..1 (triggers 0..1). Forward is positive up the field, strafe positive to the left, rotate positive counterclockwise. */
export interface Sticks {
  forward?: number
  strafe?: number
  rotate?: number
  /** right trigger: the robot code's "shooting" */
  shoot?: number
  /** left trigger: "shooting on the move" */
  shootOnMove?: number
}

export type ScriptAction =
  | { ds: 'enable' | 'disable' | 'auto' | 'teleop' }
  /** replaces all stick values (unlisted ones go to 0) */
  | { sticks: Sticks }
  /** replaces the set of held buttons: A is "intaking", B is "idle" in the robot code */
  | { buttons: Button[] }
  /** the app acts as the field system from here (enable/disable and Game Data follow the match phases) */
  | { match: 'start' | 'end' }

export type ScriptEvent = { t: number } & ScriptAction

/** Another robot on the field. It follows `route` (field coordinates, looping) and, if `shoot` is set, stops at `shoot.at` to fire FUEL at its own HUB. */
export interface BotScript {
  name: string
  alliance: 'red' | 'blue'
  start: { x: number; y: number; yaw: number }
  mass?: number
  mu?: number
  /** waypoints to drive through (field meters), looping; speed in m/s */
  route?: { x: number; y: number }[]
  speed?: number
  /** cycles: drive to `pickup`, wait for `intakeSeconds`, drive to `at`, fire `count` FUEL at `rate` per second, repeat (a simple cycling robot) */
  cycle?: { pickup: { x: number; y: number }; at: { x: number; y: number }; intakeSeconds: number; count: number; rate: number }
}

export interface RunScript {
  name: string
  game: 'test' | 'rebuilt'
  seed: number
  /** simulated seconds */
  duration: number
  /** exchange and physics step, seconds (default 0.005) */
  step?: 0.001 | 0.002 | 0.005
  start?: { x: number; y: number; yaw: number }
  /** REBUILT: FUEL staged in the neutral zone (default 360, the CAD's count) and preloaded in the robot (default from the robot definition) */
  neutralFuel?: number
  preload?: number
  bots?: BotScript[]
  events: ScriptEvent[]
}

const BUTTON_BIT: Record<Button, number> = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5 }

/** Joystick axes in the WPILib Xbox layout (0 LX, 1 LY, 2 LT, 3 RT, 4 RX, 5 RY) for the robot code's UniversalController (it negates LY, LX and RX). */
export function sticksToAxes(s: Sticks): number[] {
  return [-(s.strafe ?? 0), -(s.forward ?? 0), s.shootOnMove ?? 0, s.shoot ?? 0, -(s.rotate ?? 0), 0]
}

export function buttonMask(held: Button[]): bigint {
  let m = 0n
  for (const b of held) m |= 1n << BigInt(BUTTON_BIT[b])
  return m
}

/** Checks a script and returns a list of problems (empty when it is fine). */
export function validateScript(s: RunScript): string[] {
  const out: string[] = []
  if (!s.name) out.push('name is missing')
  if (!(s.duration > 0)) out.push('duration must be positive')
  if (s.game !== 'test' && s.game !== 'rebuilt') out.push('game must be "test" or "rebuilt"')
  let last = -1
  for (const [i, e] of s.events.entries()) {
    if (!(e.t >= 0)) out.push(`events[${i}].t must be >= 0`)
    if (e.t < last) out.push(`events[${i}] is out of order (t ${e.t} after ${last})`)
    last = e.t
    if (e.t > s.duration) out.push(`events[${i}] is after the end of the run`)
  }
  return out
}

/** Schedules every event of the script on the lockstep session's sim clock. */
export function scheduleScript(session: BridgeSession, script: RunScript): void {
  let sticks: Sticks = {}
  let buttons: Button[] = []
  const send = (): void => session.setJoystick(sticksToAxes(sticks), buttonMask(buttons), -1)
  for (const e of script.events) {
    session.at(e.t, () => {
      if ('ds' in e) {
        if (e.ds === 'disable') session.setDs({ enabled: false, autonomous: false })
        else session.setDs({ enabled: true, autonomous: e.ds === 'auto', test: false })
      } else if ('sticks' in e) { sticks = e.sticks; send() }
      else if ('buttons' in e) { buttons = e.buttons; send() }
      else if (e.match === 'start') session.startMatch()
      else session.endMatch()
    })
  }
}
