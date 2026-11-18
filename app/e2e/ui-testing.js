// Robot testing tools without robot code: breakpoints, the testing card, the Controls dialog (fake gamepad)
const { check, expect, eq, sleep, summary, launch, setPlaying } = require('./lib')
;(async () => {
  const { app, page, errors } = await launch()
  void app
  const T = (id) => page.textContent(id)
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const simT = () => ev(() => crucible.sim.latest.time)
  const startSim = async () => { await page.click('[data-tab=session]'); if ((await T('#start-sim')) === 'Stop sim') { await page.click('#start-sim'); await sleep(250) }; await page.selectOption('#game-select', 'test'); await page.fill('#seed', '42'); await page.click('#start-sim'); await page.waitForFunction(() => document.querySelector('.simhud .kv') && crucible.sim.ready, null, { timeout: 15000 }); await sleep(300) }
  const set = async (id, v) => { await page.fill(id, String(v)); await page.press(id, 'Tab') }
  const playUntilPaused = async (speed = '8') => { await page.selectOption('#speed', speed); await page.click('#play'); await page.waitForFunction(() => crucible.sim.running, null, { timeout: 10000 }).catch(() => {}); await page.waitForFunction(() => !crucible.sim.running, null, { timeout: 60000 }); await sleep(400); await page.selectOption('#speed', '1') }
  const closeSummary = async () => { if (await page.$eval('#match-summary', (d) => d.open)) await page.click('#match-summary .primary') }

  await check('B1 sim time breakpoint: the run pauses at exactly that moment, says why, does not stop again, and Reset arms it again', async () => {
    await startSim(); await page.click('[data-tab=analysis]'); await page.check('#bp-time-on'); await set('#bp-time', 3)
    await playUntilPaused(); const t = await simT(); expect(Math.abs(t - 3) < 0.0105, 'paused at ' + t)
    expect((await T('#notice')).startsWith('Paused: sim time 3 s reached at 3.00 s'), await T('#notice')); expect((await T('#bp-last')).includes('sim time 3 s reached'), await T('#bp-last')); eq(await T('#play'), 'Play')
    await setPlaying(true); await sleep(1500); await setPlaying(false); expect((await simT()) > 4, 'it runs on past the breakpoint: ' + (await simT()))
    await page.click('#sim-reset'); await sleep(400); await playUntilPaused(); const t3 = await simT(); expect(Math.abs(t3 - 3) < 0.0105, 'Reset re-armed it: ' + t3)
  })
  await check('B2 phase breakpoint stops at the phase change (test game: teleop at 5 s)', async () => {
    await page.uncheck('#bp-time-on'); await page.check('#bp-phase'); await page.click('#sim-reset'); await sleep(400); await playUntilPaused()
    const t = await simT(); expect(Math.abs(t - 5) < 0.0105, 'paused at ' + t); expect((await T('#bp-last')).includes('phase teleop'), await T('#bp-last'))
    await page.uncheck('#bp-phase')
  })
  await check('B3 breakpoints set before a start apply to the new sim; with none set the run goes on; the settings survive a reload', async () => {
    await page.check('#bp-time-on'); await set('#bp-time', 2); await startSim(); await playUntilPaused(); const t2 = await simT(); expect(Math.abs(t2 - 2) < 0.0105, 'init carried the breakpoint: ' + t2)
    await page.click('[data-tab=analysis]'); await page.uncheck('#bp-time-on'); await setPlaying(true); await sleep(1500); await setPlaying(false); expect((await simT()) > 3, 'no breakpoint: runs on')
    await page.check('#bp-launch'); await page.check('#bp-impact-on'); await set('#bp-impact', 3.5); await page.reload(); await page.waitForSelector('#start-sim'); await page.click('[data-tab=analysis]')
    eq(await ev(() => ({ l: document.getElementById('bp-launch').checked, i: document.getElementById('bp-impact-on').checked, v: document.getElementById('bp-impact').value, t: document.getElementById('bp-time-on').checked })), { l: true, i: true, v: '3.5', t: false })
    await page.uncheck('#bp-launch'); await page.uncheck('#bp-impact-on')
  })
  await check('B4 junk in the breakpoint boxes does not break anything', async () => {
    await startSim(); await page.click('[data-tab=analysis]'); await page.check('#bp-time-on'); await set('#bp-time', 'abc'); await page.check('#bp-impact-on'); await set('#bp-impact', '-4'); await sleep(300)
    await page.selectOption('#speed', '4'); await setPlaying(true); await sleep(1500); await setPlaying(false); await page.selectOption('#speed', '1')
    expect(errors.length === 0, errors.join('|')); await page.uncheck('#bp-time-on'); await page.uncheck('#bp-impact-on')
  })

  await check('F1 testing card: note follows the controls; changes are sent to a running sim; junk ids ignored; everything survives a reload', async () => {
    await page.click('[data-tab=robot]'); expect((await T('#f-note')).startsWith('Nothing injected'), await T('#f-note'))
    await ev(() => { window.__sent = []; const o = crucible.sim.send.bind(crucible.sim); crucible.sim.send = (m) => { window.__sent.push(m); o(m) } })
    await page.check('#bat-on'); await page.check('#f-brown-on'); await set('#f-brown', '6.5'); await page.fill('#f-drop', '8, 37, abc, 12x'); await page.$eval('#f-lat', (r) => { r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })) }); await page.$eval('#f-noise', (r) => { r.value = '2'; r.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(300)
    const note = await T('#f-note'); expect(note.includes('battery 12.6 V, 18 mΩ') && note.includes('brownout 6.5 V') && note.includes('latency 40 ms') && note.includes('noise 2') && note.includes('CAN 8, 37 dropped'), note)
    const sent = await ev(() => window.__sent); const f = sent.filter((m) => m.type === 'faults').pop().faults; eq(f, { brownoutVolts: 6.5, latencyMs: 40, noise: 2, dropIds: [8, 37] }); eq(sent.filter((m) => m.type === 'battery').pop().battery, { enabled: true, openVolts: 12.6, resistance: 0.018 })
    await page.reload(); await page.waitForSelector('#start-sim'); await page.click('[data-tab=robot]')
    eq(await ev(() => ({ b: document.getElementById('bat-on').checked, br: document.getElementById('f-brown-on').checked, v: document.getElementById('f-brown').value, l: document.getElementById('f-lat').value, n: document.getElementById('f-noise').value, d: document.getElementById('f-drop').value })), { b: true, br: true, v: '6.5', l: '40', n: '2', d: '8, 37, abc, 12x' })
    await page.uncheck('#bat-on'); await page.uncheck('#f-brown-on'); await page.fill('#f-drop', ''); await page.$eval('#f-lat', (r) => { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })) }); await page.$eval('#f-noise', (r) => { r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })) }); expect((await T('#f-note')).startsWith('Nothing injected'))
  })
  await check('F2 the mechanism inspector waits for robot code (nothing to draw with the scripted robot)', async () => {
    await startSim(); await page.click('[data-tab=robot]'); await sleep(600); expect((await T('#mech-inspector')).includes('Connects when robot code runs'), await T('#mech-inspector')); eq(await page.$$eval('#mech-inspector .mi-row', (r) => r.length), 0)
  })

  const pad = () => ev(() => { window.__pad = { id: 'Fake Pad (test)', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }; navigator.getGamepads = () => [window.__pad] })
  const press = (i, on = true) => ev(({ i, on }) => { window.__pad.buttons[i] = { pressed: on, value: on ? 1 : 0 } }, { i, on })
  const axis = (i, v) => ev(({ i, v }) => { window.__pad.axes[i] = v }, { i, v })
  const openControls = async () => { await page.click('[data-tab=robot]'); await page.click('#controls-btn'); expect(await page.$eval('#controls', (d) => d.open), 'dialog open') }
  await check('C1 Controls opens by the button and by G, closes with Escape; with no gamepad it says so', async () => {
    await page.click('#controls .primary').catch(() => {}); await openControls(); expect((await T('#pad-live')).includes('No gamepad found'), await T('#pad-live')); await page.keyboard.press('Escape'); await sleep(200); expect(!(await page.$eval('#controls', (d) => d.open)))
    await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.press('g'); await sleep(200); expect(await page.$eval('#controls', (d) => d.open), 'G opens it'); await page.screenshot({ path: process.env.SP + '/e2e/out/controls-nopad.png' }); await page.keyboard.press('Escape')
  })
  await check('C2 a connected gamepad is shown live: name, axis bars and values, lit button dots', async () => {
    await pad(); await openControls(); await sleep(300); expect((await T('#pad-live .pad-name')).includes('Fake Pad (test)')); eq(await page.$$eval('#pad-live .pad-axis', (a) => a.length), 4); eq(await page.$$eval('#pad-live .pad-dot', (d) => d.length), 17)
    await axis(1, -0.5); await press(3); await sleep(250)
    eq(await page.$$eval('#pad-live .pad-axis b', (b) => b.map((x) => x.textContent)), ['0.00', '-0.50', '0.00', '0.00']); eq(await page.$$eval('#pad-live .pad-dot.on', (d) => d.map((x) => x.textContent)), ['3'])
    const w = await page.$eval('#pad-live .pad-axis:nth-child(2) i', (i) => i.style.cssText); expect(/left: ?25%/.test(w) && /width: ?25%/.test(w), 'bar grows left from the middle for a negative value: ' + w)
    await axis(1, 0); await press(3, false); await page.screenshot({ path: process.env.SP + '/e2e/out/controls-pad.png' })
  })
  await check('C3 Learn: press the button for A, move the stick for the left Y axis; the mapping changes what the robot sees, invert flips it, a reload keeps it', async () => {
    await page.click('#pm-learn-b-A'); expect((await T('#pad-msg')).includes('Press the button that should be A')); await press(9); await sleep(250); await press(9, false)
    eq(await page.inputValue('#pm-b-A'), '9'); expect((await T('#pad-msg')).includes('A is now button 9'), await T('#pad-msg'))
    await page.click('#pm-learn-a-ly'); await axis(3, 0.9); await sleep(250); await axis(3, 0); eq(await page.inputValue('#pm-a-ly'), 'axis:3')
    await page.keyboard.press('Escape'); await sleep(150)
    await press(9); await axis(3, 0.8); let r = await ev(() => crucible.readInput()); eq([r.buttons & 1, r.axes[1], r.source], [1, 0.8, 'gamepad'], 'the robot sees physical button 9 as A and axis 3 as left Y')
    await openControls(); await page.check('#pm-inv-ly'); await sleep(100); await page.keyboard.press('Escape'); r = await ev(() => crucible.readInput()); eq(r.axes[1], -0.8, 'inverted')
    await page.reload(); await page.waitForSelector('#start-sim'); await pad(); await press(9); await axis(3, 0.8); r = await ev(() => crucible.readInput()); eq([r.buttons & 1, r.axes[1]], [1, -0.8], 'mapping survives a reload')
  })
  await check('C4 dead zone and "Standard layout": small stick drift is ignored; reset gives the standard mapping back', async () => {
    await pad(); await axis(0, 0.1); let r = await ev(() => crucible.readInput()); eq(r.axes[0], 0.1, 'above the default dead zone of 0.06 it passes')
    await openControls(); await page.$eval('#pm-dead', (i) => { i.value = '0.2'; i.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(100); r = await ev(() => crucible.readInput()); eq(r.axes[0], 0, 'now inside the 0.2 dead zone'); eq(await T('#pm-dead-val'), '0.20')
    await page.click('#pad-reset'); await sleep(200); eq(await page.inputValue('#pm-b-A'), '0'); eq(await page.inputValue('#pm-a-ly'), 'axis:1'); expect(!(await page.$eval('#pm-inv-ly', (c) => c.checked))); eq(await T('#pm-dead-val'), '0.06')
    await page.keyboard.press('Escape')
  })
  await check('C5 Learn with no pad says so, and Escape cancels a learn', async () => {
    await ev(() => { navigator.getGamepads = () => [] }); await openControls(); await page.click('#pm-learn-b-B'); expect((await T('#pad-msg')).includes('No gamepad connected'), await T('#pad-msg')); await page.keyboard.press('Escape')
  })
  await check('K1 rebinding: the new key drives, the old one stops; shortcut keys, taken keys and Escape are handled; Default keys restores', async () => {
    await openControls(); await page.click('#kb-btn-forward'); expect((await T('#key-msg')).includes('Press the key for "Forward"')); await page.keyboard.press('ArrowUp'); await sleep(150)
    eq(await T('#kb-forward'), '↑'); expect((await T('#key-msg')).includes('Forward: ↑'), await T('#key-msg'))
    await page.click('#kb-btn-left'); await page.keyboard.press('KeyT'); expect((await T('#key-msg')).includes('shortcut'), await T('#key-msg')); eq(await T('#kb-left'), 'press a key…', 'still waiting for a usable key after a refused one')
    await page.keyboard.press('KeyD'); expect((await T('#key-msg')).includes('already drives "Strafe right"'), await T('#key-msg')); await page.keyboard.press('Escape'); await sleep(100); eq(await T('#kb-left'), 'A', 'Escape cancels rebinding'); expect(await page.$eval('#controls', (d) => d.open), 'and does not close the dialog while rebinding')
    await page.keyboard.press('Escape'); await sleep(200); expect(!(await page.$eval('#controls', (d) => d.open)))
    await ev(() => { navigator.getGamepads = () => [] }); await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.keyboard.down('ArrowUp'); await sleep(100); let r = await ev(() => crucible.readInput()); eq([r.axes[1], r.source], [-1, 'keyboard'], 'the arrow drives forward'); await page.keyboard.up('ArrowUp')
    await page.keyboard.down('w'); await sleep(100); r = await ev(() => crucible.readInput()); eq(r.axes[1], 0, 'W no longer drives'); await page.keyboard.up('w')
    await page.reload(); await page.waitForSelector('#start-sim'); await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.down('ArrowUp'); await sleep(100); r = await ev(() => crucible.readInput()); eq(r.axes[1], -1, 'survives a reload'); await page.keyboard.up('ArrowUp')
    await page.keyboard.press('g'); await sleep(200); await page.click('#keys-reset'); eq(await T('#kb-forward'), 'W'); await page.keyboard.press('Escape'); await page.keyboard.down('w'); await sleep(100); r = await ev(() => crucible.readInput()); eq(r.axes[1], -1, 'default restored'); await page.keyboard.up('w')
  })
  await check('Z1 no unexpected page errors', async () => { const real = errors.filter((e) => !/ERR_CONNECTION_REFUSED/.test(e)); expect(real.length === 0, real.join(' | ')) })
  await app.close().catch(() => {})
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); process.exit(1) })
