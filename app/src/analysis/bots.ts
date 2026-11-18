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

/**
 * A cycling robot for the opposing alliance: takes FUEL from the neutral pile and fires it at its own HUB.
 * G407: a robot may launch into its own HUB only with its bumpers partly in its ALLIANCE ZONE, and the HUB stands on the edge of that zone (red zone: x from 12.51 m),
 * so the firing spot is in the zone beside the HUB, 2.4 m from its opening, and not out in the neutral zone. The straight line to it must clear the HUB body
 * (y 3.44 to 4.63 m at x 11.3 to 12.5): it runs below it and over the BUMP, as a real robot does.
 */
export function redCycler(): BotScript {
  return {
    name: 'red cycler', alliance: 'red', start: { x: 13.5, y: 6.5, yaw: Math.PI }, speed: 2.5,
    cycle: { pickup: { x: 8.4, y: 3.2 }, at: { x: 13.5, y: 2.3 }, intakeSeconds: 4, count: 6, rate: 2 },
  }
}

/** A blue partner that cycles like the red one, mirrored through the field center: picks up FUEL in the neutral zone and fires at the blue HUB from inside the blue ALLIANCE ZONE (x up to 4.03 m). */
export function blueAlly(): BotScript {
  return {
    name: 'blue ally', alliance: 'blue', start: { x: 3.0, y: 1.6, yaw: 0 }, speed: 2.5,
    cycle: { pickup: { x: 8.1, y: 4.9 }, at: { x: 3.04, y: 5.77 }, intakeSeconds: 4, count: 6, rate: 2 },
  }
}
