const fs = require('fs')
const { check, expect, eq, sleep, summary, launch } = require('./lib')
const { makeLog } = require('./wpilog')
const SP = process.env.SP
const OUT = SP + '/e2e/out'; fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(OUT + '/good.wpilog', makeLog(10))
const full = makeLog(10); fs.writeFileSync(OUT + '/trunc.wpilog', full.subarray(0, full.length - 7))
fs.writeFileSync(OUT + '/garbage.wpilog', Buffer.from('this is not a log file at all'))
fs.writeFileSync(OUT + '/empty.wpilog', Buffer.alloc(0))

;(async () => {
  const { app, page, errors } = await launch()
  const rows = () => page.$$eval('.simhud .kv', (rs) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent])))
  const head = () => page.$eval('.simhud-head', (e) => ({ phase: e.querySelector('.sh-phase').textContent, clock: e.querySelector('.sh-clock').textContent, blue: e.querySelector('.sh-blue').textContent, red: e.querySelector('.sh-red').textContent }))
  const simT = async () => Number((await rows())['Sim time'].replace(' s', ''))
  const hash = async () => (await rows())['State hash']
  const settle = () => sleep(250)
  const startSim = async (opts = {}) => {
    if ((await page.textContent('#start-sim')) === 'Stop sim') { await page.click('#start-sim'); await sleep(200) }
    if (opts.game) await page.selectOption('#game-select', opts.game)
    if (opts.seed !== undefined) await page.fill('#seed', String(opts.seed))
    if (opts.dt) await page.selectOption('#step-dt', opts.dt)
    if (opts.opp) await page.selectOption('#opponent', opts.opp)
    await page.click('#start-sim')
    await page.waitForFunction(() => document.querySelector('.simhud') && !document.getElementById('simhud').hidden && document.querySelector('.simhud .kv'), null, { timeout: 15000 })
    await settle()
  }
  const steps = async (n) => { for (let i = 0; i < n; i++) await page.click('#sim-step'); await settle() }

  await check('S1 Start sim (scripted, test game): button flips, status, transport + panel appear', async () => {
    await startSim({ game: 'test', seed: 42 })
    eq(await page.textContent('#start-sim'), 'Stop sim')
    expect((await page.textContent('#status')).includes('game-test'), await page.textContent('#status'))
    expect(await page.$eval('#sim-buttons', (e) => !e.hidden), 'sim buttons visible')
    expect(await page.$eval('#ds-controls', (e) => e.hidden), 'DS controls stay hidden for scripted robot')
    eq((await head()).phase, 'Auto')
    const r = await rows(); expect(r['Speed'] === 'Paused' && r['Sim time'] === '0.00 s', JSON.stringify(r))
  })
  await check('S2 Play advances time, speed reads ~1x; Pause stops it', async () => {
    await page.click('#play'); await sleep(2000)
    const t1 = await simT(); const r = await rows()
    expect(t1 > 0.5, 'sim time barely moved: ' + t1)
    expect(/real time/.test(r['Speed']), r['Speed'])
    eq(await page.textContent('#play'), 'Pause')
    await page.click('#play'); await settle(); const t2 = await simT(); await sleep(600)
    eq(await simT(), t2, 'time moved while paused')
    eq((await rows())['Speed'], 'Paused'); eq(await page.textContent('#play'), 'Play')
    return `1x run: ${t1.toFixed(2)} s simulated in 2 s wall`
  })
  await check('S3 Step button advances by what its label says (10 ms)', async () => {
    await startSim({ game: 'test', seed: 42, dt: '0.002' })
    await page.click('#sim-step'); await settle(); const d1 = await simT()
    await page.click('#sim-step'); await settle(); const d2 = (await simT()) - d1
    const label = await page.getAttribute('#sim-step', 'title')
    expect(Math.abs(d2 - 0.01) < 0.0005, `label says "${label}" but one click advances ${(d2 * 1000).toFixed(0)} ms at 2 ms step`)
  })
  await check('S4 Step stays 10 ms at a 5 ms physics step (and ignores a dropdown change after start)', async () => {
    await startSim({ game: 'test', seed: 42, dt: '0.005' })
    await page.click('#sim-step'); await settle()
    const t = await simT(); expect(Math.abs(t - 0.01) < 1e-6, `one Step = ${(t * 1000).toFixed(0)} ms at the 5 ms setting (label says 10 ms)`)
    await page.selectOption('#step-dt', '0.001'); await page.click('#sim-step'); await settle()
    expect(Math.abs((await simT()) - 0.02) < 1e-6, 'changing the dropdown after start must not change what Step does: ' + (await simT()))
  })
  await check('S5 Determinism: same seed + same steps gives the same hash, other seed differs', async () => {
    const run = async (seed) => { await startSim({ game: 'test', seed, dt: '0.002' }); await steps(30); return { t: await simT(), h: await hash() } }
    const a = await run(42), b = await run(42), c = await run(7)
    eq(a, b, 'same seed twice'); expect(a.h !== c.h, 'different seed should give a different hash')
    expect(a.h.length >= 8, 'hash looks empty: ' + a.h)
  })
  await check('S6 Reset (seed box) returns to time 0 with the fresh-start hash', async () => {
    await startSim({ game: 'test', seed: 42 }); const h0 = await hash()
    await steps(20); expect((await hash()) !== h0, 'hash should change as it runs')
    await page.click('#sim-reset'); await sleep(500)
    eq(await simT(), 0, 'time after reset'); eq(await hash(), h0, 'hash after reset')
  })
  await check('S7 Save / Load state restores the exact moment; Load disabled until a save', async () => {
    await startSim({ game: 'test', seed: 42 })
    expect(await page.$eval('#sim-load', (e) => e.disabled), 'Load should start disabled')
    await steps(15); await page.click('#sim-save'); await sleep(400)
    expect(!(await page.$eval('#sim-load', (e) => e.disabled)), 'Load should enable after Save')
    const saved = { t: await simT(), h: await hash() }
    await steps(25); expect((await hash()) !== saved.h)
    await page.click('#sim-load'); await sleep(500)
    eq({ t: await simT(), h: await hash() }, saved, 'after Load')
    await steps(10); const f1 = await hash()
    await page.click('#sim-load'); await sleep(400); await steps(10)
    eq(await hash(), f1, 'replayed future identical after Load')
  })
  await check('S8 Speed dropdown changes the sim rate (0.25x vs 4x)', async () => {
    await startSim({ game: 'test', seed: 42 })
    await page.selectOption('#speed', '0.25'); await page.click('#play'); await sleep(2500)
    const slow = parseFloat((await rows())['Speed'])
    await page.selectOption('#speed', '4'); await sleep(2500)
    const fast = parseFloat((await rows())['Speed'])
    await page.click('#play'); await page.selectOption('#speed', '1')
    expect(slow > 0.1 && slow < 0.5, '0.25x measured ' + slow)
    expect(fast > 2 && fast < 5, '4x measured ' + fast + ' (this machine may be too slow)')
    return `0.25x -> ${slow}x, 4x -> ${fast}x`
  })
  await check('S9 Space toggles play/pause, but typing a space in a field does not', async () => {
    await startSim({ game: 'test', seed: 42 })
    await page.click('#start-sim', { trial: true }); await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Space'); await sleep(300); eq(await page.textContent('#play'), 'Pause', 'Space should play')
    await page.keyboard.press('Space'); await sleep(300); eq(await page.textContent('#play'), 'Play', 'Space should pause')
    await page.click('#seed'); await page.keyboard.press('Space'); await sleep(300); eq(await page.textContent('#play'), 'Play', 'Space in the seed box must not play')
    await page.fill('#seed', '42')
  })
  await check('S10 Seed box: junk, negative and huge values do not crash and start a sim', async () => {
    for (const v of ['abc', '-5', '99999999999999', '', '3.7']) { await startSim({ game: 'test', seed: v }); expect(await hash(), 'no hash for seed ' + v) }
    expect(errors.length === 0, errors.join('|'))
    await page.fill('#seed', '42')
  })

  await check('P1 stats panel (REBUILT): groups, plain labels, tooltips, no undefined/NaN', async () => {
    await startSim({ game: 'rebuilt', seed: 42, dt: '0.002' })
    const titles = await page.$$eval('.simhud-body h4', (e) => e.map((x) => x.textContent))
    eq(titles, ['Match', 'Field', 'Game', 'Determinism'], 'groups (no Robot group without robot code)')
    const r = await rows()
    for (const k of ['HUBs', 'FUEL scored', 'Game Data', 'Fouls', 'FUEL on field', 'Impacts', 'State hash', 'Speed', 'Sim time']) expect(k in r, 'missing row ' + k + ' have ' + Object.keys(r))
    const body = await page.textContent('#simhud'); expect(!/undefined|NaN|\[object/.test(body), body)
    const tips = await page.$$eval('.simhud .kv', (e) => e.filter((x) => x.title).length); expect(tips >= 8, 'tooltips: ' + tips)
    expect(Number(r['FUEL on field'].split(' ')[0]) > 300, 'REBUILT should stage lots of FUEL: ' + r['FUEL on field'])
    await page.screenshot({ path: OUT + '/rebuilt-panel.png' })
  })
  await check('P2 panel: header always updates, collapse hides body, stays collapsed after reload', async () => {
    await startSim({ game: 'rebuilt', seed: 42 })
    expect(await page.$eval('.simhud-body', (e) => getComputedStyle(e).display !== 'none'))
    await page.click('.simhud-head'); await settle()
    eq(await page.$eval('.simhud-body', (e) => getComputedStyle(e).display), 'none')
    eq(await page.getAttribute('.simhud-head', 'aria-expanded'), 'false')
    const h = await page.$eval('#simhud', (e) => Math.round(e.getBoundingClientRect().height)); expect(h < 60, 'collapsed height ' + h)
    await page.click('#play'); await sleep(1500)
    const c = (await head()).clock; expect(parseFloat(c) > 0.3, 'header clock should keep running while collapsed: ' + c)
    await page.click('#play')
    await page.reload(); await page.waitForSelector('#start-sim')
    await page.selectOption('#game-select', 'rebuilt'); await page.click('#start-sim'); await sleep(800)
    eq(await page.getAttribute('.simhud-head', 'aria-expanded'), 'false', 'collapsed state after reload')
    await page.click('.simhud-head'); await settle()
    expect((await rows())['Sim time'] !== undefined, 'rows come back when reopened')
    expect(await page.$eval('.simhud-body', (e) => getComputedStyle(e).display !== 'none'))
  })
  await check('P3 panel in light theme: readable contrast, screenshot', async () => {
    await page.click('#theme-btn'); await settle()
    eq(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    const cols = await page.evaluate(() => { const k = getComputedStyle(document.querySelector('.simhud .kv .k')).color, v = getComputedStyle(document.querySelector('.simhud .kv .v')).color, bg = getComputedStyle(document.querySelector('.simhud')).backgroundColor; return { k, v, bg } })
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
    // the panel is translucent glass over the always-dark 3D view: judge the label color against the effective dark view too
    const eff = (() => { const a = Number(cols.bg.match(/[\d.]+/g)[3]); const c = 255 * a + 11 * (1 - a); return `rgb(${c},${c},${c})` })()
    const rk = ratio(cols.k, eff), rv = ratio(cols.v, eff)
    await page.screenshot({ path: OUT + '/light-panel.png' })
    await page.click('#theme-btn')
    expect(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark')
    if (rk < 4.5 || rv < 4.5) return `light theme: label contrast ${rk.toFixed(1)}:1, value ${rv.toFixed(1)}:1 against the effective glass background ${eff}`
  })

  await check('T1 theme toggle flips, persists across reload', async () => {
    await page.click('#theme-btn'); eq(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.reload(); await page.waitForSelector('#start-sim')
    eq(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'after reload')
    await page.click('#theme-btn'); eq(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  })
  await check('T2 About dialog opens, shows version, closes with button and Escape', async () => {
    await page.click('#about-btn'); expect(await page.$eval('#about', (d) => d.open), 'open')
    expect((await page.textContent('#about-version')).length > 0)
    await page.click('#about .primary'); await sleep(200); expect(!(await page.$eval('#about', (d) => d.open)), 'closed by button')
    await page.click('#about-btn'); await page.keyboard.press('Escape'); await sleep(200); expect(!(await page.$eval('#about', (d) => d.open)), 'closed by Escape')
  })

  await check('K1 Topics tab: sim topics appear, filter works, click plots and unplots', async () => {
    await startSim({ game: 'test', seed: 42 }); await page.click('#play'); await sleep(1500)
    await page.click('[data-tab=topics]')
    const n = await page.$$eval('#topics .topic', (e) => e.length); expect(n > 3, 'topics: ' + n)
    await page.fill('#filter', 'score'); await settle()
    const f = await page.$$eval('#topics .topic .name', (e) => e.map((x) => x.textContent)); expect(f.length > 0 && f.every((x) => /score/i.test(x)), JSON.stringify(f))
    await page.click('#topics .topic.plottable'); await settle()
    expect(await page.$eval('#topics .topic.plottable', (e) => e.classList.contains('on')), 'row should be marked on')
    expect(await page.$('#plot .uplot'), 'plot canvas should exist')
    await page.click('#topics .topic.plottable'); await settle()
    expect(!(await page.$eval('#topics .topic.plottable', (e) => e.classList.contains('on'))), 'row should switch off')
    await page.fill('#filter', '')
    await page.click('#play')
  })
  await check('K2 Clear plot button empties the plot', async () => {
    await page.fill('#filter', 'speed'); await settle(); await page.click('#topics .topic.plottable'); await settle()
    await page.click('#clear-plot'); await settle()
    expect(!(await page.$('#topics .topic.on')), 'no topic should stay selected')
    await page.fill('#filter', ''); await page.click('[data-tab=session]')
  })

  await check('L1 Open log: status, topics, pose picker auto-chosen, seek + play work', async () => {
    await page.setInputFiles('#file', OUT + '/good.wpilog'); await sleep(800)
    expect(/good\.wpilog: 2 topics, 10 s/.test(await page.textContent('#status')), await page.textContent('#status'))
    eq(await page.textContent('#start-sim'), 'Start sim', 'opening a log stops the sim')
    eq(await page.inputValue('#pose-select'), '/Swerve/Pose')
    expect(await page.$eval('#seek', (e) => !e.disabled), 'seek enabled')
    eq(await page.textContent('#time'), '0.00 / 10.00 s')
    await page.click('#play'); await sleep(1500); await page.click('#play')
    const t = parseFloat((await page.textContent('#time')).split('/')[0]); expect(t > 0.8 && t < 2.5, 'played ' + t + ' s in 1.5 s')
    await page.$eval('#seek', (e) => { e.value = '0.5'; e.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(300)
    const t2 = parseFloat((await page.textContent('#time')).split('/')[0]); expect(Math.abs(t2 - 5) < 0.3, 'seek to half gave ' + t2)
    await page.click('[data-tab=topics]'); await page.click('#topics .topic.plottable'); await settle(); expect(await page.$('#plot .uplot'), 'plot')
    await page.click('[data-tab=session]')
  })
  await check('L2 Play at the end restarts from the beginning; speed 8x finishes sooner', async () => {
    await page.selectOption('#speed', '8'); await page.click('#play'); await page.waitForFunction(() => document.getElementById('play').textContent === 'Play', null, { timeout: 8000 })
    const t = parseFloat((await page.textContent('#time')).split('/')[0]); expect(t >= 9.9, 'ended at ' + t)
    await page.click('#play'); await sleep(300); const t2 = parseFloat((await page.textContent('#time')).split('/')[0]); expect(t2 < 5, 'restart from start, got ' + t2)
    await page.click('#play'); await page.selectOption('#speed', '1')
  })
  await check('L3 Truncated log opens with a note; garbage and empty files give an error and the app survives', async () => {
    await page.setInputFiles('#file', OUT + '/trunc.wpilog'); await sleep(700)
    expect(/truncated/.test(await page.textContent('#status')), await page.textContent('#status'))
    await page.setInputFiles('#file', OUT + '/garbage.wpilog'); await sleep(700)
    const g = await page.textContent('#status'); expect(/Could not open|garbage/.test(g), 'garbage status: ' + g)
    await page.setInputFiles('#file', OUT + '/empty.wpilog'); await sleep(700)
    const e = await page.textContent('#status'); expect(/Could not open|empty/.test(e), 'empty status: ' + e)
    await page.setInputFiles('#file', OUT + '/good.wpilog'); await sleep(700)
    expect(/good\.wpilog/.test(await page.textContent('#status')), 'recovers by opening a good file')
  })
  await check('L4 Drag-and-drop a .wpilog onto the window', async () => {
    const b64 = fs.readFileSync(OUT + '/good.wpilog').toString('base64')
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.wpilog'))
      window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, b64); await sleep(800)
    expect(/dropped\.wpilog/.test(await page.textContent('#status')), await page.textContent('#status'))
    expect(!(await page.$eval('#drop', (e) => e.classList.contains('show'))), 'drop overlay should hide')
  })
  await check('L5 Starting a sim after a log replaces it; Connect to a dead host shows Connecting then Disconnect resets', async () => {
    await startSim({ game: 'test', seed: 42 }); expect((await page.textContent('#status')).includes('game-test'))
    await page.fill('#host', '127.0.0.1'); await page.click('#connect'); await sleep(800)
    eq(await page.textContent('#connect'), 'Disconnect'); eq(await page.textContent('#start-sim'), 'Start sim', 'Connect stops the sim')
    expect(/NT 127\.0\.0\.1: (Connecting|Disconnected)/.test(await page.textContent('#status')), await page.textContent('#status'))
    await page.click('#connect'); await sleep(300); eq(await page.textContent('#connect'), 'Connect'); eq(await page.textContent('#status'), 'No data')
  })

  const stub = (p) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => (p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined }) }, p)
  await check('V1 Screenshot button writes a real, non-blank PNG', async () => {
    await startSim({ game: 'rebuilt', seed: 42 }); await sleep(500)
    const out = OUT + '/shot.png'; try { fs.unlinkSync(out) } catch {}
    await stub(out); await page.click('#shot-btn'); await sleep(1500)
    expect(fs.existsSync(out), 'no PNG written; notice: ' + (await page.textContent('#notice')))
    const b = fs.readFileSync(out); expect(b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'not a PNG'); expect(b.length > 5000, 'tiny PNG ' + b.length)
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20); expect(w > 400 && h > 200, `size ${w}x${h}`)
  })
  await check('V2 Screenshot cancel writes nothing and does not break the app', async () => {
    const out = OUT + '/never.png'; try { fs.unlinkSync(out) } catch {}
    await stub(null); await page.click('#shot-btn'); await sleep(800)
    expect(!fs.existsSync(out)); expect(await page.$eval('#shot-btn', (e) => !e.disabled), 'button still usable')
  })
  await check('V3 Record: indicator + timer, stop writes a playable-looking WebM', async () => {
    const out = OUT + '/rec.webm'; try { fs.unlinkSync(out) } catch {}
    await stub(out); await page.click('#play'); await page.click('#rec-btn'); await sleep(2500)
    expect(await page.$eval('#rec-btn', (e) => e.classList.contains('on')), 'rec button should show recording')
    expect(!(await page.$eval('#rec-time', (e) => e.hidden)), 'timer visible'); const tm = await page.textContent('#rec-time'); expect(/0:0[1-9]/.test(tm), 'timer ' + tm)
    await page.click('#rec-btn'); await sleep(2500)
    expect(!(await page.$eval('#rec-btn', (e) => e.classList.contains('on'))), 'indicator off after stop')
    expect(fs.existsSync(out), 'no file; notice: ' + (await page.textContent('#notice')))
    const b = fs.readFileSync(out); expect(b.subarray(0, 4).toString('hex') === '1a45dfa3', 'not WebM'); expect(b.length > 3000, 'tiny video ' + b.length)
    await page.click('#play')
  })

  await check('Z1 no unexpected errors in the page the whole run', async () => { const real = errors.filter((e) => !/ERR_CONNECTION_REFUSED/.test(e)); expect(real.length === 0, real.join(' | ')) })
  await app.close().catch(() => {})
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); process.exit(1) })
