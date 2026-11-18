// Turns a script's bots into the engine's other robots (with the HUB each one fires at filled in).
import type { OtherRobotSpec } from '../engine/types'
import { FIELD_LENGTH, HUB_RIM, HUB_X, HUB_Y } from '../games/rebuilt'
import type { BotScript } from './script'

export function hubTarget(alliance: 'red' | 'blue'): [number, number, number] {
  return [alliance === 'blue' ? HUB_X : FIELD_LENGTH - HUB_X, HUB_Y, HUB_RIM]
}

export function botsToOthers(bots: BotScript[]): OtherRobotSpec[] {
  return bots.map((b) => ({
    name: b.name,
    alliance: b.alliance,
    half: [0.43, 0.43, 0.12],
    mass: b.mass ?? 55,
    mu: b.mu ?? 1.0,
    start: b.start,
    ai: b.route || b.cycle ? {
      route: b.route,
      speed: b.speed,
      cycle: b.cycle ? { ...b.cycle, target: hubTarget(b.alliance) } : undefined,
    } : undefined,
  }))
}

/** A cycling robot for the opposing alliance: takes FUEL from the neutral pile and fires it at its own HUB from the near side (a straight line to the firing spot must not cross the HUB). */
export function redCycler(): BotScript {
  return {
    name: 'red cycler', alliance: 'red', start: { x: 13.5, y: 6.5, yaw: Math.PI }, speed: 2.5,
    cycle: { pickup: { x: 8.4, y: 3.2 }, at: { x: 10.0, y: 4.0 }, intakeSeconds: 4, count: 6, rate: 2 },
  }
}

/** A blue partner that cycles like the red one, mirrored: picks up FUEL in the neutral zone and fires at the blue HUB. */
export function blueAlly(): BotScript {
  return {
    name: 'blue ally', alliance: 'blue', start: { x: 3.0, y: 1.6, yaw: 0 }, speed: 2.5,
    cycle: { pickup: { x: 8.1, y: 4.9 }, at: { x: 6.5, y: 4.0 }, intakeSeconds: 4, count: 6, rate: 2 },
  }
}
