// UI test of robot-code-in-the-loop against a fake robot on the real ports (5811 bridge, 5810 NT). Temporary: not part of the repo.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { it } from 'vitest'
import { decodeFromApp, encodeToApp, type FromApp } from '../src/engine/bridge/frames'
import { MSG_DS, MSG_HELLO, MSG_JOYSTICK, MSG_POSE_SEED, MSG_STATS, MSG_STEP, MSG_TO_APP, MSG_FROM_APP, MSG_VISION } from '../src/engine/bridge/ws-transport'
import { OFFSEASON, OFFSEASON_DRIVETRAIN } from '../src/robots/offseason'
import { FakeRobotWs } from '../tests/helpers/fake-ws-robot'
import { FakeNtServer } from '../tests/helpers/fake-nt-server'

const req = createRequire(import.meta.url)
const { _electron } = req('playwright')
const SP = process.env.SP!
const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const IDS = [...OFFSEASON_DRIVETRAIN.modules.flatMap((m) => [m.driveId, m.steerId]), ...OFFSEASON.mechanisms.map((m) => m.id)]
const SLOW = Number(process.env.E2E_SLOW) || 1
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms <= 800 ? ms * SLOW : ms)) // short waits stretch on a busy runner; long ones are durations
const results: { name: string; status: string; note: string }[] = []

async function check(name: string, fn: () => Promise<string | void>, page?: any): Promise<void> {
  try { const r = await fn(); results.push({ name, status: typeof r === 'string' ? 'NOTE' : 'PASS', note: typeof r === 'string' ? r : '' }) }
  catch (e: any) {
    try { if (page) await page.screenshot({ path: `${SP}/e2e/fail-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` }) } catch { /* */ }
    results.push({ name, status: 'FAIL', note: String(e?.message ?? e).split('\n')[0].slice(0, 300) })
  }
  const r = results[results.length - 1]
  console.log(`${r.status.padEnd(4)} ${r.name}${r.note ? '  -- ' + r.note : ''}`)
}
const expect = (c: unknown, m = 'expectation failed'): void => { if (!c) throw new Error(m) }
const eq = (a: unknown, b: unknown, m = 'not equal'): void => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }

class FakeRobot {
  ws = new FakeRobotWs()
  nt = new FakeNtServer()
  seq = 0n; t = 0; volts: Record<number, number> = {}; enabled = false; lockstep = false
  ds: { flags: number; matchTime: number; gameData: number }[] = []
  joystick: { axes: number[]; buttons: bigint }[] = []
  poseSeeds = 0; steps = 0; fromApp = 0; limit = Infinity
  /** what the app sent back, newest last (bounded), and how long each answer took */
  recent: FromApp[] = []
  /** drive the wheels from the left stick (open loop, no steering): lets the scenarios move the robot straight */
  autoDrive = false
  latencies: number[] = []
  /** the vision messages (bridge message 9) the app sent, parsed */
  vision: { t: number; tags: { id: number; distance: number }[]; pose: { x: number; y: number; yaw: number; tags: number } | null }[] = []
  private sentAt = new Map<number, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  sendHello = true
  lockstepHello = false
  toApp(seq: bigint, t: number): Uint8Array {
    return encodeToApp({ seq, simTime: t, batteryVolts: 12, flags: this.enabled ? 1 : 0, motors: IDS.map((id) => ({ id, appliedVolts: this.volts[id] ?? 0, flags: 0 })) })
  }
  async start(): Promise<void> {
    await this.nt.start(5810); await this.ws.start(5811)
    this.ws.onConnect = () => {
      if (this.timer) { clearInterval(this.timer); this.timer = null } // a reconnect (a restarted sim) must not leave the old frame timer running
      if (this.sendHello) this.ws.send(MSG_HELLO, new TextEncoder().encode(JSON.stringify({ protocol: 0, ...(this.lockstepHello ? { lockstep: true } : {}), devices: [{ type: 'talonfx', id: 20 }], mechanisms: [] })))
      const stats = new Uint8Array(24); new DataView(stats.buffer).setFloat64(0, 4500, true); this.ws.send(MSG_STATS, stats)
      if (!this.lockstep) this.timer = setInterval(() => { this.seq++; this.t += 0.02; this.sentAt.set(Number(this.seq), Date.now()); this.ws.send(MSG_TO_APP, this.toApp(this.seq, this.t)) }, 20)
    }
    this.ws.onMessage = (m) => {
      const v = new DataView(m.body.buffer, m.body.byteOffset, m.body.byteLength)
      if (m.type === MSG_DS) { if (this.autoDrive && (v.getUint32(8, true) & 1) === 0) for (const mod of OFFSEASON_DRIVETRAIN.modules) this.volts[mod.driveId] = 0; this.ds.push({ flags: v.getUint32(8, true), gameData: v.getUint8(14), matchTime: v.getFloat64(16, true) }); this.enabled = (v.getUint32(8, true) & 1) !== 0 }
      else if (m.type === MSG_JOYSTICK) {
        const axes: number[] = []; for (let i = 0; i < 6; i++) axes.push(v.getFloat64(8 + i * 8, true)); this.joystick.push({ axes, buttons: v.getBigUint64(56, true) })
        if (this.autoDrive) for (const mod of OFFSEASON_DRIVETRAIN.modules) this.volts[mod.driveId] = this.enabled ? -axes[1] * 12 : 0
      }
      else if (m.type === MSG_POSE_SEED) this.poseSeeds++
      else if (m.type === MSG_VISION) { try { this.vision.push(JSON.parse(new TextDecoder().decode(m.body))) } catch { /* counted as missing */ } }
      else if (m.type === MSG_FROM_APP) {
        this.fromApp++
        const d = decodeFromApp(m.body)
        if (d) { this.recent.push(d); if (this.recent.length > 60) this.recent.shift(); const t0 = this.sentAt.get(Number(d.seq)); if (t0) { this.latencies.push(Date.now() - t0); if (this.latencies.length > 60) this.latencies.shift() } }
      }
      else if (m.type === MSG_STEP) { if (this.t >= this.limit) return; this.steps++; const seq = v.getBigUint64(0, true); const dt = v.getFloat64(8, true); this.t += dt; this.ws.send(MSG_TO_APP, this.toApp(seq, this.t)) }
    }
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.ws.stop(); this.nt.stop() }
}

it('robot code UI e2e', async () => {
  const app = await _electron.launch({
    executablePath: APP + '/node_modules/electron/dist/electron',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--in-process-gpu', APP], cwd: APP,
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message))
  page.on('console', (m: any) => { if (m.type() === 'error' && !/404|ERR_CONNECTION_REFUSED/.test(m.text())) errors.push('console: ' + m.text()) })
  await page.waitForSelector('#start-sim', { timeout: 30000 })

  const rows = (): Promise<Record<string, string>> => page.$$eval('.simhud .kv', (rs: any[]) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])))
  const head = (): Promise<any> => page.$eval('.simhud-head', (e: any) => ({ phase: e.querySelector('.sh-phase').textContent, clock: e.querySelector('.sh-clock').textContent }))
  const titles = (): Promise<string[]> => page.$$eval('.simhud-body h4', (e: any[]) => e.map((x) => x.textContent))
  const until = async (f: () => Promise<boolean> | boolean, ms = 8000, what: string | (() => string) = 'condition'): Promise<void> => { const t0 = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + (typeof what === 'function' ? what() : what)); await sleep(100) } }
  // the Play button toggles on what the page last heard from the worker: say what is wanted and make it so (read the label, click only when it differs, wait for it to follow)
  const setPlaying = async (want: boolean): Promise<void> => {
    const t0 = Date.now()
    for (;;) {
      if ((await page.evaluate(() => /^(Pause|Duraklat)$/.test(document.getElementById('play')!.textContent!.trim()))) === want) return
      await page.click('#play')
      try { await page.waitForFunction((w) => /^(Pause|Duraklat)$/.test(document.getElementById('play')!.textContent!.trim()) === w, want, { timeout: 2500 }); return } catch { /* the click was lost: look again */ }
      if (Date.now() - t0 > 20000) throw new Error(`the Play button did not turn to "${want ? 'Pause' : 'Play'}"`)
    }
  }
  const startRobotSim = async (mode: 'robot' | 'lockstep', game = 'rebuilt'): Promise<void> => {
    if ((await page.textContent('#start-sim')) === 'Stop sim') { await page.click('#start-sim'); await sleep(300) }
    await page.click('[data-tab=robot]'); await page.selectOption('#sim-mode', mode); await page.click('[data-tab=session]')
    await page.selectOption('#game-select', game); await page.click('#start-sim')
    await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 15000 })
  }

  // ---------- R1: no robot yet
  await check('R1 robot mode with no robot: panel says waiting, DS controls visible, Step disabled, no crash', async () => {
    await startRobotSim('robot')
    await sleep(1500)
    const r = await rows()
    eq(r['Robot program'], 'waiting for it…')
    eq(await page.textContent('#play'), 'Pause', 'robot-code sims start running by themselves')
    expect(!('Robot state' in r), 'no robot state row before frames')
    expect(await page.$eval('#ds-controls', (e: any) => !e.hidden), 'DS controls visible')
    expect(await page.$eval('#sim-step', (e: any) => e.disabled), 'Step should be disabled with robot code')
    expect((await page.textContent('#status')).includes('robot code via NT'), await page.textContent('#status'))
    expect(errors.length === 0, errors.join('|'))
  }, page)

  // ---------- R2: robot appears
  const robot = new FakeRobot()
  let live: FakeRobot = robot
  await robot.start()
  await check('R2 robot connects: link turns connected, frames flow, round trip + hello problem shown', async () => {
    await until(async () => (await rows())['Robot program'] === 'connected', 10000, 'connected')
    // wait for the frames instead of counting them after a fixed pause: a busy runner delivers them later, not never
    await until(async () => Number((await rows())['Frames']) > 20, 15000, 'more than 20 frames')
    const r = await rows()
    expect(Number(r['Frames']) > 20, 'frames ' + r['Frames'])
    eq(r['Robot state'], 'disabled')
    expect(/^\d+(\.\d+)? ms$/.test(r['Round trip']), 'round trip ' + r['Round trip'])
    expect('Problem' in r && /does not register|missing|talon/i.test(r['Problem']), 'hello problem row: ' + JSON.stringify(r))
    expect(await page.$eval('.simhud .kv .v.bad', (e: any) => e.textContent.length > 0), 'problem row in red')
    const t = titles(); const tt = await t
    expect(tt.includes('Robot link') && tt.includes('Mechanisms') && tt.includes('Robot'), 'groups ' + tt)
    expect(robot.fromApp > 20, 'app answers frames: ' + robot.fromApp)
  }, page)
  await check('R3 Mechanisms section lists every robot mechanism', async () => {
    const r = await rows()
    for (const n of OFFSEASON.mechanisms.map((m) => m.name)) expect(n in r, 'mechanism row missing: ' + n + ' have ' + Object.keys(r).join(','))
    expect(/rot · .* rps/.test(r['turret']), r['turret'])
  }, page)
  await check('R4 applied volts move the mechanism: turret position changes, speed row non-zero, then settles', async () => {
    const p0 = parseFloat((await rows())['turret'])
    robot.volts[0] = 6; await sleep(1500)
    const r = await rows(); const p1 = parseFloat(r['turret']); const rps = parseFloat(r['turret'].split('·')[1])
    expect(Math.abs(p1 - p0) > 0.05 && Math.abs(rps) > 0.1, `turret ${p0} -> ${r['turret']}`)
    robot.volts[0] = 0; await sleep(2500)
    expect(Math.abs(parseFloat((await rows())['turret'].split('·')[1])) < Math.abs(rps), 'speed should decay after volts removed')
  }, page)

  // ---------- Driver Station
  await check('R5 Enable sends DS enabled, robot reports enabled, button flips; Disable undoes it', async () => {
    robot.ds.length = 0
    await page.click('#ds-enable'); for (let i = 0; i < 40 && !robot.ds.some((d) => d.flags & 1); i++) await sleep(150)
    expect(robot.ds.some((d) => d.flags & 1), 'no DS frame with enabled bit')
    eq(await page.textContent('#ds-enable'), 'Disable')
    await page.waitForFunction(() => [...document.querySelectorAll('.simhud .kv')].some((r) => r.querySelector('.k')!.textContent === 'Robot state' && r.querySelector('.v')!.textContent === 'enabled'), null, { timeout: 20000 }).catch(() => {})
    eq((await rows())['Robot state'], 'enabled')
    await page.click('#ds-enable'); for (let i = 0; i < 40 && (robot.ds[robot.ds.length - 1].flags & 1); i++) await sleep(150)
    await page.waitForFunction(() => [...document.querySelectorAll('.simhud .kv')].some((r) => r.querySelector('.k')!.textContent === 'Robot state' && r.querySelector('.v')!.textContent === 'disabled'), null, { timeout: 20000 }).catch(() => {})
    expect(!(robot.ds[robot.ds.length - 1].flags & 1), 'last DS should be disabled')
    eq(await page.textContent('#ds-enable'), 'Enable'); eq((await rows())['Robot state'], 'disabled')
  }, page)
  await check('R6 Teleop / Auto / Test picker sets the right DS mode bits', async () => {
    await page.click('#ds-enable')
    const flagFor = async (m: string) => { robot.ds.length = 0; await page.selectOption('#ds-mode', m); const want = m === 'auto' ? 3 : m === 'test' ? 5 : 1; for (let i = 0; i < 40 && !(robot.ds.length && (robot.ds[robot.ds.length - 1].flags & 7) === want); i++) await sleep(150); return robot.ds[robot.ds.length - 1].flags & 7 }
    eq(await flagFor('auto'), 1 | 2, 'auto'); eq(await flagFor('test'), 1 | 4, 'test'); eq(await flagFor('teleop'), 1, 'teleop')
    await page.click('#ds-enable'); await sleep(300)
  }, page)

  // ---------- keyboard
  await check('R7 keyboard drives the robot: W moves an axis, release returns to 0, J presses button A', async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    robot.joystick.length = 0
    await page.keyboard.down('w'); await sleep(700)
    const held = robot.joystick[robot.joystick.length - 1]
    expect(held && held.axes.some((a) => a !== 0), 'W should set an axis: ' + JSON.stringify(held?.axes))
    await page.keyboard.up('w'); await sleep(700)
    expect(robot.joystick[robot.joystick.length - 1].axes.every((a) => a === 0), 'axes should return to 0')
    await page.keyboard.down('j'); await sleep(500)
    expect((robot.joystick[robot.joystick.length - 1].buttons & 1n) === 1n, 'J should press button A (bit 0)'); await page.keyboard.up('j'); await sleep(400)
    expect(robot.joystick[robot.joystick.length - 1].buttons === 0n, 'buttons released')
  }, page)
  await check('R8 keyboard works right after using the DS mode picker (focus left on the <select>)', async () => {
    await page.click('#ds-mode'); await page.keyboard.press('Escape') // a real mouse click on the picker, then the choice
    await page.selectOption('#ds-mode', 'auto'); await page.click('#ds-mode'); await page.keyboard.press('Escape'); await page.selectOption('#ds-mode', 'teleop')
    robot.joystick.length = 0
    await page.keyboard.down('w'); await sleep(700); await page.keyboard.up('w')
    const moved = robot.joystick.some((j) => j.axes.some((a) => a !== 0))
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    expect(moved, 'driving keys are ignored right after choosing from the Teleop/Auto/Test picker with the mouse')
  }, page)
  await check('R9 keys typed into the NT host / seed boxes do not drive the robot', async () => {
    robot.joystick.length = 0
    await page.click('#seed'); await page.keyboard.type('wasd'); await sleep(600)
    const bad = robot.joystick.some((j) => j.axes.some((a) => a !== 0))
    await page.fill('#seed', '42'); await page.locator('body').click({ position: { x: 4, y: 4 } })
    expect(!bad, 'typing in the seed box moved the robot')
  }, page)

  // ---------- reset, match
  await check('R10 Reset re-seeds the robot pose and returns sim time to 0', async () => {
    const before = robot.poseSeeds
    await page.click('#sim-reset')
    await until(async () => robot.poseSeeds > before, 8000, 'pose seed sent to the robot')
    // the clock restarts from 0 and keeps running (a slow runner shows it late), so it is only required to have come back under a few seconds
    let c = 99
    await until(async () => { c = parseFloat((await head()).clock); return c < 3 }, 8000, () => 'clock after reset (last ' + c + ')')
  }, page)
  await check('R11 Start match: phase becomes Auto, robot enabled in AUTO with the autonomous bit, clock runs', async () => {
    robot.ds.length = 0
    await page.click('#match-start'); await sleep(2500)
    eq((await head()).phase, 'Auto')
    const last = robot.ds[robot.ds.length - 1]
    expect(last && (last.flags & 3) === 3, 'DS in auto should be enabled|autonomous, got ' + JSON.stringify(last))
    expect(last.matchTime >= 0 && last.matchTime < 30, 'match time ' + last?.matchTime)
    expect(parseFloat((await head()).clock) > 1.5, 'clock ' + (await head()).clock)
    const r = await rows(); expect(/active/.test(r['HUBs']), 'HUBs ' + r['HUBs'])
    eq(r['Game Data'], 'not sent yet')
  }, page)
  await check('R12 End match hands the Driver Station back: robot disabled, then the Enable button works again', async () => {
    await page.click('#match-end'); await sleep(1200)
    const last = robot.ds[robot.ds.length - 1]
    expect(!(last.flags & 1), 'robot should be disabled after End match, flags ' + last.flags)
    robot.ds.length = 0; await page.click('#ds-enable'); await sleep(700)
    expect(robot.ds.some((d) => d.flags & 1), 'Enable should work again after End match'); await page.click('#ds-enable'); await sleep(300)
    const ph = (await head()).phase
    return `End match does not stop the sim clock: the header still says "${ph}" (by design: it only gives control back)`
  }, page)
  await check('R13 Impacts / FUEL rows stay sane while the robot idles (no NaN, no undefined)', async () => {
    const body = await page.textContent('#simhud'); expect(!/NaN|undefined|Infinity/.test(body), body)
    await page.screenshot({ path: SP + '/e2e/out/robot-panel.png' })
  }, page)

  // ---------- robot disappears and returns
  await check('R14 robot process dies: link flips to waiting, UI stays alive; returns when it comes back', async () => {
    robot.stop(); await until(async () => (await rows())['Robot program'] === 'waiting for it…', 12000, 'waiting after loss')
    expect(await page.$eval('#play', (e: any) => !e.disabled), 'UI controls alive')
    const r2 = new FakeRobot(); r2.sendHello = false; await r2.start()
    await until(async () => (await rows())['Robot program'] === 'connected', 15000, 'reconnect')
    await sleep(800); expect(r2.fromApp > 10, 'frames resume after reconnect: ' + r2.fromApp)
    live = r2
  }, page)

  await check('R14b live tuning reaches the running robot sim: less tire friction, slower acceleration; a changed mass applies after Reset and the sim survives', async () => {
    const drive = [20, 23, 26, 29]
    // the speed 0.25 s of sim time after full voltage starts: still accelerating, so grip decides it
    const speedAfter = async (): Promise<number> => {
      await page.click('#sim-reset'); await sleep(500)
      const t0 = await page.evaluate(() => (window as any).crucible.sim.latest.time)
      for (const id of drive) live.volts[id] = 12
      await page.waitForFunction((t: number) => (window as any).crucible.sim.latest.time >= t + 0.25, t0, { timeout: 10000 })
      const v = await page.evaluate(() => (window as any).crucible.sim.latest.robotSpeed)
      for (const id of drive) live.volts[id] = 0
      await sleep(1500)
      return v
    }
    const base = await speedAfter()
    await page.click('[data-tab=tune]')
    await page.$eval('#tune-mu', (r: any) => { r.value = '0.45'; r.dispatchEvent(new Event('input', { bubbles: true })) })
    await sleep(300)
    const slow = await speedAfter()
    const diag = await page.evaluate(() => { const c = (window as any).crucible; return JSON.stringify({ running: c.sim.running, frames: c.sim.bridge?.frames, enabled: c.sim.bridge?.robotEnabled, connected: c.sim.bridge?.connected, t: c.sim.latest.time, pos: c.sim.latest.robot.slice(0, 2) }) })
    expect(base > 0.3, 'the robot should accelerate with 12 V on the drive motors: ' + base + ' ' + diag + ' volts ' + JSON.stringify(live.volts))
    expect(slow < base * 0.85, `tire friction 0.45 should accelerate slower than 1.2: ${base.toFixed(2)} -> ${slow.toFixed(2)} m/s`)
    await page.$eval('#tune-mass-n', (n: any) => { n.value = '66'; n.dispatchEvent(new Event('change', { bubbles: true })) })
    await sleep(300); await page.click('#sim-reset'); await sleep(600)
    expect(await page.$eval('#start-sim', (b: any) => b.textContent) === 'Stop sim', 'the sim keeps running after a mass change and Reset')
  }, page)
  await page.click('#tune-reset').catch(() => {}); await page.click('[data-tab=session]').catch(() => {})

  // ---------- testing tools with robot code
  const setRange = async (id: string, v: string): Promise<void> => { await page.$eval(id, (r: any, v: string) => { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })) }, v) }
  await check('R16 faults reach the robot: brownout voltage, a dropped CAN device, sensor noise, latency; the battery model sags under drive load and shows in the panel', async () => {
    await page.click('[data-tab=robot]')
    const last = (): FromApp => live.recent[live.recent.length - 1]
    await sleep(300); expect(last().batteryVolts === 12 && last().motors.some((m) => m.id === 0), 'clean state at first')
    await page.check('#f-brown-on'); await page.fill('#f-brown', '6.5'); await page.press('#f-brown', 'Tab'); await sleep(400)
    expect(Math.abs(last().batteryVolts - 6.5) < 1e-6, 'brownout reaches the robot: ' + last().batteryVolts); await page.uncheck('#f-brown-on'); await sleep(400); eq(last().batteryVolts, 12, 'and goes away')
    await page.fill('#f-drop', '0, 1'); await sleep(400); expect(!last().motors.some((m) => m.id === 0 || m.id === 1) && last().motors.some((m) => m.id === 4), 'ids 0 and 1 stop answering, others still do'); await page.fill('#f-drop', ''); await sleep(400); expect(last().motors.some((m) => m.id === 0), 'and answer again')
    const spread = (): number => { const v = live.recent.slice(-30).map((f) => f.motors.find((m) => m.id === 4)!.rotorPositionRot); return Math.max(...v) - Math.min(...v) }
    await sleep(700); const quiet = spread(); await setRange('#f-noise', '3'); await sleep(900); const noisy = spread(); await setRange('#f-noise', '0'); await sleep(900)
    expect(noisy > quiet + 0.002, `noise visible in the rotor position: ${quiet} -> ${noisy}`); expect(spread() < 0.0005, 'noise off again')
    const base = live.latencies.slice(-20).reduce((a, b) => a + b, 0) / 20; live.latencies.length = 0; await setRange('#f-lat', '120'); await sleep(1500); const slow = live.latencies.slice(-15).reduce((a, b) => a + b, 0) / 15; await setRange('#f-lat', '0'); await sleep(600)
    expect(slow > 100 && slow > base + 80, `latency: ${base.toFixed(0)} ms -> ${slow.toFixed(0)} ms`)
    await page.check('#bat-on'); await sleep(300); for (const id of [20, 23, 26, 29]) live.volts[id] = 12
    let low = 99; for (let i = 0; i < 25; i++) { await sleep(40); low = Math.min(low, last().batteryVolts) }
    const panel = await page.$$eval('.simhud .kv', (rs: any[]) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])))
    for (const id of [20, 23, 26, 29]) live.volts[id] = 0
    expect(low < 11, 'the battery sags under full drive voltage: lowest ' + low); expect(/^\d+\.\d V · \d+ A$/.test(panel['Battery']), 'panel shows it: ' + panel['Battery'])
    await sleep(1200); await page.uncheck('#bat-on'); await sleep(400); eq(last().batteryVolts, 12, 'battery model off: back to what the robot reported')
  }, page)
  await check('R17 the mechanism inspector draws volts, speed, position and current for every mechanism, with the values the robot applies', async () => {
    await page.click('[data-tab=robot]'); live.volts[0] = 6; await sleep(1500)
    const rows = await page.$$eval('#mech-inspector .mi-row .mi-name', (e: any[]) => e.map((x) => x.textContent)); for (const n of OFFSEASON.mechanisms.map((m) => m.name)) expect(rows.includes(n), 'inspector row for ' + n + ': ' + rows)
    const turret = await page.evaluate(() => { const r = [...document.querySelectorAll('#mech-inspector .mi-row')].find((x: any) => x.querySelector('.mi-name').textContent === 'turret') as any; return { paths: [...r.querySelectorAll('path')].map((p: any) => p.getAttribute('d').length), vals: [...r.querySelectorAll('.mi-cap b')].map((b: any) => b.textContent) } })
    expect(turret.paths.length === 4 && turret.paths.every((n: number) => n > 10), 'four charts with data: ' + JSON.stringify(turret.paths)); expect(/^6\.0 V$/.test(turret.vals[2]) && /^\d+ A$/.test(turret.vals[3]), 'volts and amps shown: ' + turret.vals)
    live.volts[0] = 0; await sleep(300)
  }, page)
  await check('R18 rebound driving keys drive the robot, the old key stops; the dialog and the robot agree', async () => {
    await page.click('[data-tab=robot]'); await page.click('#controls-btn'); await page.click('#kb-btn-forward'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape'); await sleep(200)
    await page.locator('body').click({ position: { x: 4, y: 4 } }); live.joystick.length = 0
    await page.keyboard.down('ArrowUp'); for (let i = 0; i < 40 && !live.joystick.some((j) => j.axes[1] === -1); i++) await sleep(150); const up = live.joystick.find((j) => j.axes[1] === -1) ?? live.joystick[live.joystick.length - 1]; await page.keyboard.up('ArrowUp'); await sleep(300)
    live.joystick.length = 0; await page.keyboard.down('w'); await sleep(500); const w = live.joystick.some((j) => j.axes.some((a) => a !== 0)); await page.keyboard.up('w')
    await page.keyboard.press('g'); await page.click('#keys-reset'); await page.keyboard.press('Escape'); await sleep(200)
    expect(up && up.axes[1] === -1, 'ArrowUp pushes the left stick forward: ' + JSON.stringify(up?.axes)); expect(!w, 'W no longer drives after the rebind')
  }, page)
  await check('R19 a breakpoint pauses a robot-code sim (its clock stands still while the robot keeps sending), Play continues', async () => {
    const now = await page.evaluate(() => (window as any).crucible.sim.latest.time)
    await page.click('[data-tab=analysis]'); await page.check('#bp-time-on'); await page.fill('#bp-time', String(Math.ceil(now) + 6)); await page.press('#bp-time', 'Tab')
    await page.waitForFunction(() => !(window as any).crucible.sim.running, null, { timeout: 45000 }).catch(async (e) => { throw new Error('the breakpoint never paused the sim: ' + JSON.stringify(await page.evaluate(() => { const s = (window as any).crucible.sim; return { time: s.latest?.time, running: s.running, rate: s.simRate, connected: s.bridge?.connected, frames: s.bridge?.frames, bp: (document.getElementById('bp-time') as HTMLInputElement).value, bpOn: (document.getElementById('bp-time-on') as HTMLInputElement).checked } })) + ' wanted ' + (Math.ceil(now) + 6) + ' from ' + now + ' | ' + String(e.message).split('\n')[0]) })
    const t0 = await page.evaluate(() => (window as any).crucible.sim.latest.time); expect(Math.abs(t0 - (Math.ceil(now) + 6)) < 0.3, `paused near the breakpoint: ${t0} (wanted ${Math.ceil(now) + 6})`)
    const f0 = live.fromApp; await sleep(800); const t1 = await page.evaluate(() => (window as any).crucible.sim.latest.time); expect(Math.abs(t1 - t0) < 0.03, 'sim clock frozen: ' + t0 + ' -> ' + t1); expect(live.fromApp > f0 + 10, 'the robot is still being answered')
    expect((await page.textContent('#bp-last'))!.includes('sim time'), await page.textContent('#bp-last')); await page.uncheck('#bp-time-on')
    await setPlaying(true); await sleep(1200); const t2 = await page.evaluate(() => (window as any).crucible.sim.latest.time); expect(t2 > t1 + 0.5, 'Play continues: ' + t1 + ' -> ' + t2)
    await page.click('[data-tab=session]')
  }, page)

  await check('R20 scenarios: Drive forward and Climb the BUMP pass against a robot that drives on the stick; Strafe fails because this robot cannot steer, and says which checks failed', async () => {
    live.autoDrive = true
    await page.click('[data-tab=robot]')
    const outcome = async (id: string): Promise<{ badge: string; checks: string[] }> => {
      await page.click(`#sc-run-${id}`)
      await page.waitForFunction((id: string) => document.querySelector(`#sc-results .sc-res[data-id=${id}]`), id, { timeout: 60000 })
      return page.evaluate((id: string) => { const b = document.querySelector(`#sc-results .sc-res[data-id=${id}]`)!; return { badge: b.querySelector('.badge')!.textContent!, checks: [...b.querySelectorAll('.chk')].map((c: any) => c.className.replace('chk ', '') + ' ' + c.textContent) } }, id)
    }
    const fwd = await outcome('forward'); expect(fwd.badge === 'PASS' && fwd.checks.length === 3 && fwd.checks.every((c) => c.startsWith('ok')), 'forward: ' + JSON.stringify(fwd))
    expect((await page.textContent('#sc-status'))!.startsWith('Done: 1 of 1 passed'), await page.textContent('#sc-status'))
    expect(await page.$eval('#sc-run-forward', (b: any) => !b.disabled) && await page.$eval('#sc-stop', (b: any) => b.disabled), 'buttons usable again afterwards')
    const bump = await outcome('bump'); expect(bump.badge === 'PASS', 'bump: ' + JSON.stringify(bump))
    const strafe = await outcome('strafe'); expect(strafe.badge === 'FAIL' && strafe.checks.some((c) => c.startsWith('bad moved left')), 'strafe fails on "moved left": ' + JSON.stringify(strafe))
    live.autoDrive = false; for (const mod of OFFSEASON_DRIVETRAIN.modules) live.volts[mod.driveId] = 0
  }, page)
  await check('R21 a scenario takes the keyboard away from the driver while it runs, and Stop ends it, disabling the robot', async () => {
    live.autoDrive = true
    await page.click('#sc-run-forward'); await page.waitForFunction(() => (window as any).crucible.scenarioRun && (window as any).crucible.scenarioRun.phase === 'running', null, { timeout: 30000 })
    live.joystick.length = 0; await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.down('d'); await sleep(500); await page.keyboard.up('d')
    expect(!live.joystick.some((j) => j.axes[0] !== 0), 'the D key did not reach the robot during a scenario')
    await page.click('#sc-stop'); await sleep(600)
    const last = live.ds[live.ds.length - 1]; expect(!(last.flags & 1), 'the robot is disabled after Stop'); expect((await page.textContent('#sc-status'))!.includes('Stopped'), await page.textContent('#sc-status'))
    expect(await page.evaluate(() => (window as any).crucible.scenarioRun) === null, 'no scenario left running'); expect((await page.$$eval('#sc-results .sc-res .err', (e: any[]) => e.map((x) => x.textContent))).includes('stopped'), 'the stopped scenario is listed as failed with the reason')
    live.autoDrive = false
  }, page)
  await check('R22 vision camera: off sends the exact pose and no tags; on sends the tags in view and a pose estimate that follows the robot; error 0 is exact; off again goes back to the exact pose', async () => {
    await page.click('#sim-reset'); await sleep(500)
    await page.click('[data-tab=robot]')
    live.vision.length = 0; await sleep(700)
    const t0 = await page.evaluate(() => { const r = (window as any).crucible.sim.latest.robot; return { x: r[0], y: r[1] } })
    expect(live.vision.length > 0 && live.vision.every((v) => v.tags.length === 0 && v.pose !== null && Math.hypot(v.pose!.x - t0.x, v.pose!.y - t0.y) < 0.05), 'the camera off still sends the exact pose, with no tags: ' + JSON.stringify(live.vision.slice(-1)))
    await page.check('#vis-on'); await page.fill('#vis-noise', '0'); await sleep(1200)
    expect(live.vision.length >= 5, 'vision messages arrive: ' + live.vision.length)
    const last = live.vision[live.vision.length - 1]
    expect(last.tags.length > 0 && last.pose !== null, 'the robot sees tags from its start position: ' + JSON.stringify(last))
    const truth = await page.evaluate(() => { const r = (window as any).crucible.sim.latest.robot; return { x: r[0], y: r[1] } })
    expect(Math.hypot(last.pose!.x - truth.x, last.pose!.y - truth.y) < 0.05, `exact estimate at error 0: ${JSON.stringify(last.pose)} vs ${JSON.stringify(truth)}`)
    expect((await page.textContent('#vis-note'))!.startsWith('On'), await page.textContent('#vis-note'))
    await page.click('[data-tab=session]'); const row = await page.evaluate(() => [...document.querySelectorAll('#simhud *')].map((e) => e.textContent).filter((t) => /tags? ·/.test(t || '')).length); expect(row > 0, 'the panel shows a Vision row')
    await page.click('[data-tab=robot]'); await page.fill('#vis-noise', '3'); await sleep(1000)
    const noisy = live.vision.slice(-8).filter((v) => v.pose); const off = noisy.map((v) => Math.hypot(v.pose!.x - truth.x, v.pose!.y - truth.y)); expect(Math.max(...off) > 0.005, 'estimates are noisy at error 3: ' + off.join(','))
    await page.uncheck('#vis-on'); await sleep(400); live.vision.length = 0; await sleep(600); expect(live.vision.length > 0 && live.vision.every((v) => v.tags.length === 0), 'back to the exact pose without tags after turning it off: ' + live.vision.length)
    await page.click('[data-tab=session]')
  }, page)
  await page.click('[data-tab=session]').catch(() => {})

  // ---------- stop
  await check('R15 Stop sim hides the panel and DS controls, then lockstep mode starts clean', async () => {
    await page.click('#start-sim'); await sleep(500)
    expect(await page.$eval('#simhud', (e: any) => e.hidden), 'panel hidden'); expect(await page.$eval('#ds-controls', (e: any) => e.hidden), 'DS hidden')
    expect(await page.$eval('#sim-buttons', (e: any) => e.hidden), 'sim buttons hidden')
    eq(await page.textContent('#start-sim'), 'Start sim')
  }, page)
  live.stop()

  // ---------- lockstep
  const bad = new FakeRobot(); bad.lockstep = true // a robot started without CRUCIBLE_MODE=lockstep: its hello does not say lockstep
  await bad.start()
  await check('L0 lockstep against a robot that is not in lockstep mode: red problem tells how to fix it, nothing steps', async () => {
    await startRobotSim('lockstep')
    await until(async () => (await rows())['Robot program'] === 'connected', 10000, 'connected')
    await sleep(1500)
    const r = await rows()
    expect(/not in lockstep mode.*CRUCIBLE_MODE=lockstep/.test(r['Problem'] ?? ''), 'problem row: ' + JSON.stringify(r['Problem']))
    expect(await page.$$eval('.simhud .kv .v.bad', (es: any[]) => es.some((e) => /lockstep/.test(e.textContent))), 'shown in red')
    eq(bad.steps, 0, 'no steps')
    await page.click('#start-sim'); await sleep(300)
  }, page)
  bad.stop(); await sleep(500)
  const lock = new FakeRobot(); lock.lockstep = true; lock.lockstepHello = true
  await lock.start()
  await check('L1 lockstep: robot connects, the sim runs by itself and follows the robot clock only through Step exchanges', async () => {
    await startRobotSim('lockstep')
    await until(async () => (await rows())['Robot program'] === 'connected', 10000, 'connected')
    await until(async () => lock.steps > 50, 15000, 'steps: ' + lock.steps)
    // the shown time is a frame behind the robot's clock, and a loaded runner shows frames late: look for the two to agree rather than once
    let simT = 0, robotT = 0
    await until(async () => { robotT = lock.t; simT = parseFloat((await rows())['Sim time']); return Math.abs(simT - robotT) < 0.5 }, 10000, () => `app sim time ${simT} vs robot clock ${robotT}`)
    expect((await page.textContent('#status')).includes('lockstep'), await page.textContent('#status'))
    eq(await page.textContent('#play'), 'Pause')
  }, page)
  await check('L2 lockstep Pause stops the exchange, Play resumes; max speed runs faster than real time', async () => {
    await setPlaying(false); await sleep(500); const s = lock.steps; await sleep(800); eq(lock.steps, s, 'steps while paused')
    eq(await page.textContent('#play'), 'Play')
    await page.selectOption('#speed', '0'); await setPlaying(true); await sleep(300); const t0 = lock.t; await sleep(2000)
    const rate = (lock.t - t0) / 2
    await setPlaying(false); await page.selectOption('#speed', '1'); await setPlaying(true)
    expect(rate > 1.2, 'max speed ran at ' + rate.toFixed(2) + 'x'); return `max speed ran ${rate.toFixed(1)}x real time against a fake robot`
  }, page)
  await check('L3 lockstep DS Enable reaches the robot', async () => {
    lock.ds.length = 0; await page.click('#ds-enable'); await sleep(700)
    expect(lock.ds.some((d) => d.flags & 1), 'no enabled DS'); await page.click('#ds-enable')
  }, page)
  await check('L4 lockstep determinism: two runs frozen at the same step give the same state hash and time', async () => {
    const run = async (): Promise<string> => {
      await page.click('#start-sim'); await sleep(400)
      lock.t = 0; lock.limit = 1.0
      await page.selectOption('#speed', '0')
      await page.click('#start-sim'); await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 15000 })
      await until(() => lock.t >= 1.0, 30000, 'robot clock 1 s'); await sleep(1500)
      const r = await rows(); return r['Sim time'] + ' ' + r['State hash']
    }
    const a = await run(); const b = await run()
    eq(a, b, 'two lockstep runs')
    await page.selectOption('#speed', '1'); lock.limit = Infinity
  }, page)
  lock.stop()

  await check('Z1 no unexpected page errors during the robot-code run', async () => { expect(errors.length === 0, errors.join(' | ')) }, page)
  await app.close().catch(() => {})
  const c = { PASS: 0, NOTE: 0, FAIL: 0 } as Record<string, number>; for (const r of results) c[r.status]++
  console.log(`\nSUMMARY: ${c.PASS} pass, ${c.NOTE} note, ${c.FAIL} fail`)
  fs.writeFileSync(SP + '/e2e/robot-results.json', JSON.stringify(results, null, 2))
}, 600_000)
