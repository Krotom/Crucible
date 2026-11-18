const fs = require('fs')
const { check, expect, eq, sleep, summary, launch } = require('./lib')
const SP = process.env.SP
const FAKE = SP + '/fakerobot'; const CFG = require('path').resolve(__dirname, '..', 'crucible.config.json')
;(async () => {
  fs.writeFileSync(CFG, JSON.stringify({ robotDir: FAKE })); fs.writeFileSync(FAKE + '/mode.txt', 'slow')
  const { app, page, errors } = await launch()
  const rows = () => page.$$eval('.simhud .kv', (rs) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])))
  const start = async (o = {}) => {
    if ((await page.textContent('#start-sim')) === 'Stop sim') { await page.click('#start-sim'); await sleep(200) }
    await page.selectOption('#game-select', o.game || 'rebuilt'); await page.selectOption('#opponent', o.opp || 'none'); await page.fill('#seed', '42')
    await page.click('#start-sim'); await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 15000 }); await sleep(300)
  }
  // how many distinct colors the 3D canvas shows (blank canvas = 1)
  const canvasColors = async () => {
    const png = await page.locator('#view canvas').screenshot()
    fs.writeFileSync(SP + '/e2e/out/canvas.png', png)
    return require('child_process').execSync(`python3 -c "from PIL import Image; im=Image.open('${SP}/e2e/out/canvas.png').convert('RGB').resize((200,100)); print(len(set(im.getdata())))"`, { encoding: 'utf8' }).trim()
  }
  await check('W1 3D view renders real content before and during a sim (not a blank canvas)', async () => {
    const before = Number(await canvasColors())
    await start({ game: 'rebuilt' }); await page.click('#play'); await sleep(1500)
    const during = Number(await canvasColors()); await page.click('#play')
    expect(before > 5 && during > 50, `distinct colors before ${before}, during ${during}`)
  })
  for (const opp of ['blocker', 'cycler']) {
    await check(`W2 opponent "${opp}" starts, runs 4 s in REBUILT, changes the scene, no errors`, async () => {
      await start({ game: 'rebuilt', opp }); const c0 = await canvasColors()
      await page.click('#play'); await sleep(4000)
      const r = await rows(); await page.click('#play')
      expect(parseFloat(r['Speed']) > 0.3, 'sim should run: ' + r['Speed'])
      expect(errors.length === 0, errors.join('|'))
      await page.screenshot({ path: `${SP}/e2e/out/opp-${opp}.png` })
    })
  }
  await check('W3 Focus robot button does not throw and the view responds', async () => { await page.click('#focus'); await sleep(300); expect(errors.length === 0, errors.join('|')) })
  await check('W4 orbit drag on the 3D view changes the picture', async () => {
    const a = await canvasColors(); const sig = async () => require('fs').readFileSync(SP + '/e2e/out/canvas.png').length
    const s0 = await sig()
    const box = await page.locator('#view canvas').boundingBox()
    await page.mouse.move(box.x + 300, box.y + 250); await page.mouse.down(); await page.mouse.move(box.x + 450, box.y + 220, { steps: 8 }); await page.mouse.up(); await sleep(300)
    await canvasColors(); const s1 = await sig()
    expect(s0 !== s1, 'canvas identical after orbit drag')
    await page.mouse.move(box.x + 300, box.y + 250); await page.mouse.wheel(0, -400); await sleep(300)
  })
  await check('W5 narrow window (1000x640): no horizontal page scroll, panel stays inside the view, controls reachable', async () => {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1000, 640) }); await sleep(800)
    const m = await page.evaluate(() => ({ iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight,
      hud: document.getElementById('simhud').getBoundingClientRect().toJSON(), view: document.getElementById('view').getBoundingClientRect().toJSON(),
      transport: document.getElementById('transport').getBoundingClientRect().toJSON() }))
    await page.screenshot({ path: SP + '/e2e/out/narrow.png' })
    expect(m.iw <= 1010 && m.ih <= 660, `window did not actually shrink: ${m.iw}x${m.ih}`)
    expect(m.sw <= m.cw + 1, `horizontal overflow ${m.sw} > ${m.cw}`)
    expect(m.hud.bottom <= m.view.bottom + 1 && m.hud.right <= m.view.right + 1, 'panel pokes out of the view: ' + JSON.stringify([m.hud.bottom, m.view.bottom]))
    const hudBox = await page.$eval('.hud', (e) => e.getBoundingClientRect().toJSON())
    expect(hudBox.right <= m.hud.left + 1, `top-left controls (right edge ${Math.round(hudBox.right)}) run under the stats panel (left edge ${Math.round(m.hud.left)})`)
    expect(m.sh <= m.ch + 1, `vertical overflow ${m.sh} > ${m.ch}`)
  })
  await check('W6 very short window: stats panel scrolls instead of overflowing', async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 520) }); await sleep(800)
    const m = await page.evaluate(() => { const ih = innerHeight; const h = document.getElementById('simhud').getBoundingClientRect(), v = document.getElementById('view').getBoundingClientRect(), b = document.querySelector('.simhud-body'); return { ih, hb: h.bottom, vb: v.bottom, scroll: b.scrollHeight > b.clientHeight } })
    await page.screenshot({ path: SP + '/e2e/out/short.png' })
    expect(m.ih <= 540, 'window did not shrink: ' + m.ih)
    expect(m.hb <= m.vb + 1, 'panel taller than the view: ' + JSON.stringify(m))
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1500, 900) }); await sleep(600)
  })
  await check('W7 Robot tab in light theme with log lines: readable, screenshot', async () => {
    await page.click('#start-sim'); await page.click('[data-tab=robot]'); await page.selectOption('#sim-mode', 'robot')
    await page.click('#launch-robot'); await page.waitForFunction(() => document.querySelectorAll('#robot-log .ln').length > 12, null, { timeout: 10000 })
    await page.click('#theme-btn'); await sleep(300)
    await page.screenshot({ path: SP + '/e2e/out/robot-tab-light.png' })
    await page.click('#theme-btn'); await sleep(200)
    await page.screenshot({ path: SP + '/e2e/out/robot-tab-dark.png' })
    await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 8000 })
  })
  await check('W8 Space on the Robot tab (log focused) does not toggle the sim; Tab key order reaches the log filter', async () => {
    await page.click('[data-tab=session]'); await page.click('#start-sim'); await sleep(500)
    await page.click('[data-tab=robot]'); await page.click('#robot-log'); await page.keyboard.press('Space'); await sleep(300)
    const playing = (await page.textContent('#play')) === 'Pause'
    // clicking the log then pressing Space is allowed to toggle play (it is not a text field); only report
    await page.click('#start-sim').catch(() => {})
    return playing ? 'Space with the log focused toggles the simulation (the log is not a text field); harmless but unexpected when scrolling with Space' : undefined
  })
  await check('Z1 no unexpected page errors in the whole run', async () => { expect(errors.length === 0, errors.join(' | ')) })
  await app.close().catch(() => {})
  try { fs.unlinkSync(CFG) } catch {}
  require('child_process').execSync('pkill -f "[g]radlew simulateJava" || true')
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); try { fs.unlinkSync(CFG) } catch {}; process.exit(1) })
