import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Engine } from '../src/engine/engine'
import { gameFromModule } from '../src/engine/plugin'
import { buildSetup } from '../src/engine/setup'

describe('the example game plugin', () => {
  it('is a valid game module, loaded the same way the simulation worker loads a plugin file', async () => {
    const src = readFileSync(new URL('../examples/game-plugin.js', import.meta.url), 'utf8')
    const mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
    const r = gameFromModule(mod)
    expect('game' in r, JSON.stringify(r)).toBe(true)
  })
  it('runs: a ball dropped into the goal scores in auto (3 points) and the match has the three phases', async () => {
    const src = readFileSync(new URL('../examples/game-plugin.js', import.meta.url), 'utf8')
    const mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
    const r = gameFromModule(mod); if (!('game' in r)) throw new Error(r.error)
    const setup = buildSetup({ mode: 'script', game: 'plugin:game-plugin.js', gameModule: r.game })
    expect(setup.config.game.id).toBe('game-plugin-example'); expect(setup.config.game.field().length).toBe(6)
    const e = await Engine.create({ ...setup.config, seed: 1 })
    expect(e.getFrame(false).phase).toBe('auto'); for (let i = 0; i < 800; i++) e.step() // 1.6 s of sim time
    expect(e.getFrame(false).time).toBeGreaterThan(1.5); e.dispose()
  }, 30000)
})
