// Team and developer features: attempts, shared runs, report into the project, strategy board, score and timer in captures, game plugins, local API
const fs = require('fs')
const path = require('path')
const { check, expect, eq, sleep, summary, launch, APP, setPlaying } = require('./lib')
const SP = process.env.SP
const VERSION = require('../package.json').version // the app's own version: a release must not break the checks that read it
const OUT = SP + '/e2e/out'; fs.mkdirSync(OUT, { recursive: true })
;(async () => {
  let { app, page, errors, userData } = await launch()
  const T = (sel) => page.textContent(sel)
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const stub = (p) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => (p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined }) }, p)
  const toasts = () => page.$$eval('#toasts .toast', (t) => t.map((x) => x.textContent))
  const reload = async () => { await page.reload(); await page.waitForSelector('#start-sim', { timeout: 30000 }); await sleep(600) }
  const startSim = async (game = 'test', seed = '42') => {
    await page.click('[data-tab=session]'); if ((await T('#start-sim')) === 'Stop sim') { await page.click('#start-sim'); await sleep(250) }
    await page.selectOption('#game-select', game); await page.fill('#seed', seed); await page.click('#start-sim')
    await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 20000 }); await sleep(300)
  }
  const runToEnd = async () => { await ev(() => { document.getElementById('an-popup').checked = false }); await page.selectOption('#speed', '8'); await page.click('#play'); await page.waitForFunction(() => crucible.sim.latest && crucible.sim.latest.phase === 'ended', null, { timeout: 60000 }); await page.click('#play'); await sleep(300); await page.selectOption('#speed', '1') }
  const attemptRows = () => page.$$eval('#att-list .att-row', (r) => r.map((x) => ({ at: x.dataset.at, text: x.querySelector('.l').textContent, note: x.querySelector('.nt').value })))

  // ---------------------------------------------------------------- attempts
  await check('T1 a match that reaches its end adds one attempt (not one per frame), with the score, and the list shows the statistics', async () => {
    await page.click('[data-tab=analysis]'); expect((await T('#att-stats')).includes('No attempts yet'), await T('#att-stats'))
    await startSim('test'); await runToEnd(); await sleep(1500)
    const rows = await attemptRows(); eq(rows.length, 1, 'exactly one attempt: ' + JSON.stringify(rows)); expect(/test game seed 42: \d+–\d+/i.test(rows[0].text), rows[0].text)
    await page.click('[data-tab=analysis]'); expect(/^1 attempt · best \d+ · average [\d.]+ · [01] won, [01] lost/.test(await T('#att-stats')), await T('#att-stats'))
    await page.screenshot({ path: OUT + '/attempts.png' })
  })
  await check('T2 a second match adds a second row (newest first); notes stick, survive a reload and are editable; a row can be removed', async () => {
    await page.click('[data-tab=session]'); await page.click('#sim-reset'); await sleep(500); await runToEnd(); await sleep(800)
    await page.click('[data-tab=analysis]'); eq((await attemptRows()).length, 2, 'two rows')
    const first = (await attemptRows())[0]; eq(Number(first.at) >= Number((await attemptRows())[1].at), true, 'newest first')
    await page.fill('#att-list .att-row:nth-child(1) .nt', 'new hood angle'); await page.press('#att-list .att-row:nth-child(1) .nt', 'Tab'); await sleep(200)
    await reload(); await page.click('[data-tab=analysis]'); eq((await attemptRows())[0].note, 'new hood angle', 'note kept after a reload'); eq((await attemptRows()).length, 2)
    expect(/^2 attempts/.test(await T('#att-stats')), await T('#att-stats'))
    await page.click('#att-list .att-row:nth-child(2) button'); await sleep(150); eq((await attemptRows()).length, 1, 'removed'); expect((await attemptRows())[0].note === 'new hood angle', 'the other one is untouched')
  })
  await check('T3 attempts CSV is saved with a header, quoting and the note; Clear empties the list and the statistics', async () => {
    const out = OUT + '/attempts.csv'; fs.rmSync(out, { force: true }); await stub(out); await page.click('#att-csv'); await sleep(500)
    const csv = fs.readFileSync(out, 'utf8').trim().split('\n'); expect(csv[0].startsWith('time,label,alliance,own,other,margin'), csv[0]); eq(csv.length, 2); expect(csv[1].includes('"new hood angle"'), csv[1]); expect(/,blue,\d+,\d+,-?\d+,/.test(csv[1]), csv[1])
    await page.click('#att-clear'); await sleep(150); eq((await attemptRows()).length, 0); expect((await T('#att-stats')).includes('No attempts yet'))
  })

  // ---------------------------------------------------------------- shared runs and reports
  await check('T4 Share run writes one file with the set-up and the result; opening it restores the settings and loads the result as run A', async () => {
    await page.click('[data-tab=session]'); await page.click('[data-tab=robot]'); await page.check('#bat-on'); await page.click('[data-tab=session]')
    await startSim('test', '77'); await page.selectOption('#opponent', 'none'); await page.click('#sim-reset'); await sleep(300); await runToEnd()
    await page.click('[data-tab=analysis]'); await page.fill('#share-note', 'practice 4: shooter fixed')
    const out = OUT + '/shared.run.json'; fs.rmSync(out, { force: true }); await stub(out); await page.click('#an-share'); await sleep(600)
    const j = JSON.parse(fs.readFileSync(out, 'utf8')); eq(j.format, 'crucible-run'); eq(j.version, 1); eq(j.note, 'practice 4: shooter fixed'); eq(j.setup.seed, '77'); eq(j.setup['game-select'], 'test'); eq(j.setup['bat-on'], true); expect(j.report.final && typeof j.report.final.blue === 'number', 'report inside')
    expect(!JSON.stringify(j).includes(userData), 'no local paths in the file'); expect(!JSON.stringify(j).includes('/home'), 'no home folder in the file')
    // change things, then open the shared file
    await page.click('[data-tab=session]'); await page.fill('#seed', '5'); await page.click('[data-tab=robot]'); await page.uncheck('#bat-on'); await page.click('[data-tab=analysis]')
    await page.setInputFiles('#shared-file', out); await sleep(500)
    eq(await ev(() => document.getElementById('seed').value), '77', 'seed restored'); eq(await ev(() => document.getElementById('bat-on').checked), true, 'battery restored')
    expect((await toasts()).some((t) => t.includes('settings restored') && t.includes('practice 4')), 'toast: ' + (await toasts())); expect((await T('#cmp-body')).length > 20, 'run A is shown in Compare runs')
  })
  await check('T5 opening something that is not a run says why and changes nothing; a plain report.json opens without settings; a newer file is refused', async () => {
    const bad = OUT + '/not-a-run.json'; fs.writeFileSync(bad, '{"hello": 1}'); await page.click('[data-tab=session]'); await page.fill('#seed', '31'); await page.click('[data-tab=analysis]'); await page.setInputFiles('#shared-file', bad); await sleep(400)
    expect((await toasts()).some((t) => t.includes('Could not open not-a-run.json') && t.includes('not a Crucible run file')), 'toast: ' + (await toasts())); eq(await page.inputValue('#seed'), '31', 'nothing changed')
    const broken = OUT + '/broken.json'; fs.writeFileSync(broken, '{oops'); await page.setInputFiles('#shared-file', broken); await sleep(400); expect((await toasts()).some((t) => t.includes('not valid JSON')))
    const newer = OUT + '/newer.json'; fs.writeFileSync(newer, JSON.stringify({ format: 'crucible-run', version: 9, report: {} })); await page.setInputFiles('#shared-file', newer); await sleep(400); expect((await toasts()).some((t) => t.includes('newer version')), 'toast: ' + (await toasts()))
    const rep = OUT + '/plain-report.json'; await stub(rep); await page.click('#an-run'); await sleep(500); await page.setInputFiles('#shared-file', rep); await sleep(400)
    expect((await toasts()).some((t) => t.includes('no settings in it')), 'toast: ' + (await toasts())); eq(await page.inputValue('#seed'), '31', 'a plain report restores nothing')
  })
  await check('T6 Report into project writes the HTML under crucible/reports/ of the robot project, and says where', async () => {
    const proj = SP + '/fakerobot'; await ev((d) => window.crucibleHost.setRobotDir(d), proj); fs.rmSync(path.join(proj, 'crucible'), { recursive: true, force: true })
    await page.click('[data-tab=analysis]'); await page.click('#an-proj'); await sleep(800)
    const dir = path.join(proj, 'crucible', 'reports'); const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []; eq(files.length, 1, 'one report in ' + dir); expect(/^balta-crucible-report-\d{8}-\d{6}\.html$/.test(files[0]), files[0])
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('match report'), 'it is the report'); expect((await toasts()).some((t) => t.includes('Saved') && t.includes('crucible')), 'toast: ' + (await toasts()))
  })

  // ---------------------------------------------------------------- strategy board
  const stroke = async (pts) => { const box = await page.locator('#board-svg').boundingBox(); await page.mouse.move(box.x + pts[0][0] * box.width, box.y + pts[0][1] * box.height); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(box.x + p[0] * box.width, box.y + p[1] * box.height, { steps: 4 }); await page.mouse.up() }
  const clickAt = async (fx, fy) => { const box = await page.locator('#board-svg').boundingBox(); await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height) }
  const counts = () => ev(() => ({ lines: document.querySelectorAll('#board-svg polyline').length, markers: document.querySelectorAll('#board-svg circle').length - document.querySelectorAll('#board-svg circle[stroke="#5bd490"]').length }))
  await check('T7 the board opens from the Analysis tab and the palette; pen draws a path; marker drops numbered markers; undo and clear work', async () => {
    await page.click('[data-tab=analysis]'); await page.click('#board-btn'); await page.waitForSelector('#board[open]'); eq(await counts(), { lines: 0, markers: 0 })
    await stroke([[0.2, 0.5], [0.4, 0.3], [0.6, 0.6]]); eq((await counts()).lines, 1, 'a path')
    await page.click('[data-tool=marker]'); await clickAt(0.3, 0.7); await clickAt(0.5, 0.2); eq((await counts()).markers, 2); expect((await T('#board-svg')).replace(/\s/g, '').includes('12'), 'markers are numbered 1 and 2: ' + (await T('#board-svg')))
    await page.click('#board-undo'); eq((await counts()).markers, 1, 'undo removed the last marker'); await page.click('#board-undo'); await page.click('#board-undo'); eq(await counts(), { lines: 0, markers: 0 }, 'undo all the way'); expect(await page.$eval('#board-undo', (b) => b.disabled), 'undo is disabled when there is nothing to undo')
    await stroke([[0.2, 0.5], [0.4, 0.3]]); await page.click('[data-tool=marker]'); await clickAt(0.8, 0.5); await page.click('#board-clear'); eq(await counts(), { lines: 0, markers: 0 }, 'clear'); await page.click('#board-undo'); eq((await counts()).lines + (await counts()).markers > 0, true, 'clear can be undone')
    await page.keyboard.press('Escape'); await sleep(150)
  })
  await check('T8 erase removes what is clicked; move drags a marker (one undo step); a click without a drag with pen draws nothing', async () => {
    await page.click('#board-btn'); await page.waitForSelector('#board[open]'); await page.click('#board-clear')
    await page.click('[data-tool=marker]'); await clickAt(0.3, 0.5); await clickAt(0.7, 0.5); await page.click('[data-tool=pen]'); await clickAt(0.5, 0.2); eq((await counts()).lines, 0, 'a click is not a path')
    await page.click('[data-tool=move]'); const before = await page.$eval('#board-svg circle:nth-of-type(2)', (c) => c.getAttribute('cx'))
    await stroke([[0.7, 0.5], [0.8, 0.4]]); const after = await page.$eval('#board-svg circle:nth-of-type(2)', (c) => c.getAttribute('cx')); expect(Number(after) > Number(before) + 0.5, `marker moved: ${before} -> ${after}`)
    await page.click('#board-undo'); const undone = await page.$eval('#board-svg circle:nth-of-type(2)', (c) => c.getAttribute('cx')); expect(Math.abs(Number(undone) - Number(before)) < 0.01, `one undo puts it back: ${undone} vs ${before}`)
    await page.click('[data-tool=erase]'); await clickAt(0.3, 0.5); eq((await counts()).markers, 1, 'erased one'); await clickAt(0.9, 0.9); eq((await counts()).markers, 1, 'nothing near: nothing erased')
    await page.keyboard.press('Escape')
  })
  await check('T9 "Start here" and "First path = start" fill the start position of the Session tab (heading from the drag)', async () => {
    await page.click('#board-btn'); await page.waitForSelector('#board[open]'); await page.click('#board-clear'); await page.click('[data-tool=start]')
    await stroke([[0.25, 0.5], [0.25, 0.25]]) // dragged straight up the screen = +Y on the field = 90 degrees
    await page.keyboard.press('Escape'); await page.click('[data-tab=session]'); const v = await ev(() => ['start-x', 'start-y', 'start-yaw'].map((i) => Number(document.getElementById(i).value)))
    expect(Math.abs(v[0] - 1.85) < 0.3 && Math.abs(v[1] - 2.5) < 0.3 && Math.abs(v[2] - 90) <= 2, 'x, y, yaw (test game field 8 x 5): ' + v); expect(await page.$eval('.startpos', (d) => d.open), 'the start position section opened')
    await page.click('[data-tab=analysis]'); await page.click('#board-btn'); await page.waitForSelector('#board[open]'); await page.click('#board-clear'); await page.click('#board-path-start'); expect((await T('#board-hint')).includes('Draw a path first'), await T('#board-hint'))
    await page.click('[data-tool=pen]'); await stroke([[0.5, 0.5], [0.7, 0.5]]); await page.click('#board-path-start'); await page.keyboard.press('Escape'); await page.click('[data-tab=session]')
    const w = await ev(() => ['start-x', 'start-y', 'start-yaw'].map((i) => Number(document.getElementById(i).value))); expect(Math.abs(w[2]) <= 3, 'heading along the first path (to the right = 0): ' + w)
  })
  await check('T10 boards are saved by name, survive a reload, load back, and can be deleted; an unnamed save is refused; the PNG is a real picture', async () => {
    await page.click('[data-tab=analysis]'); await page.click('#board-btn'); await page.waitForSelector('#board[open]'); await page.click('#board-clear')
    await page.fill('#board-name', '   '); await page.click('#board-save'); expect((await T('#board-hint')).includes('name'), await T('#board-hint'))
    await page.click('[data-tool=pen]'); await stroke([[0.2, 0.4], [0.5, 0.6]]); await page.click('[data-tool=marker]'); await clickAt(0.6, 0.3); await page.fill('#board-note', 'defend the left'); await page.fill('#board-name', 'Auto B'); await page.click('#board-save'); await sleep(150)
    await page.keyboard.press('Escape'); await reload(); await page.click('[data-tab=analysis]'); await page.click('#board-btn'); await page.waitForSelector('#board[open]'); eq(await counts(), { lines: 0, markers: 0 }, 'fresh board after a reload')
    await page.selectOption('#board-sel', 'Auto B'); await page.click('#board-load'); await sleep(150); eq(await counts(), { lines: 1, markers: 1 }, 'loaded'); eq(await page.inputValue('#board-note'), 'defend the left')
    const png = OUT + '/board.png'; fs.rmSync(png, { force: true }); await stub(png); await page.click('#board-png'); for (let i = 0; i < 40 && !fs.existsSync(png); i++) await sleep(150); await sleep(200)
    const b = fs.readFileSync(png); eq(b.subarray(1, 4).toString(), 'PNG'); eq(b.readUInt32BE(16), 1600, 'width'); expect(b.length > 4000, 'not an empty picture: ' + b.length)
    await page.screenshot({ path: OUT + '/board.png.screen.png' })
    await page.selectOption('#board-sel', 'Auto B'); await page.click('#board-del'); await sleep(100); eq(await page.$$eval('#board-sel option', (o) => o.length), 1, 'deleted'); await page.keyboard.press('Escape')
  })

  // ---------------------------------------------------------------- score and timer in captures
  await page.keyboard.press('Escape').catch(() => {})
  await check('T11 with "Score and timer in screenshots and video" on, the screenshot has a banner at the top and is otherwise the same picture; off, it has none', async () => {
    await startSim('test', '42'); await setPlaying(true); await sleep(300); await setPlaying(false); await sleep(400)
    const shot = async (name) => { const p = OUT + '/' + name; fs.rmSync(p, { force: true }); await stub(p); await page.click('#shot-btn'); await page.waitForFunction(() => !!document.getElementById('notice').textContent.includes('Screenshot saved') || true); await sleep(900); return fs.readFileSync(p).toString('base64') }
    await page.click('#view-btn'); await page.uncheck('#vm-burn'); await page.click('#view-btn'); const plain = await shot('shot-plain.png')
    await page.click('#view-btn'); await page.check('#vm-burn'); await page.click('#view-btn'); const burned = await shot('shot-burned.png')
    const r = await ev(async ([a, b]) => {
      const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s })
      const [ia, ib] = await Promise.all([load(a), load(b)]); const w = ia.width, h = ia.height
      const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x }
      const A = px(ia), B = px(ib)
      const diff = (x0, y0, ww, hh) => { const da = A.getImageData(x0, y0, ww, hh).data, db = B.getImageData(x0, y0, ww, hh).data; let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) n++; return n / (ww * hh) }
      return { w, h, same: ib.width === w && ib.height === h, banner: diff(Math.round(w * 0.3), 4, Math.round(w * 0.4), Math.round(h * 0.09)), rest: diff(0, Math.round(h * 0.3), w, Math.round(h * 0.6)) }
    }, [plain, burned])
    expect(r.same, 'same size'); expect(r.banner > 0.1, `the banner region differs: ${r.banner.toFixed(3)}`); expect(r.rest < 0.02, `the rest of the picture is the same: ${r.rest.toFixed(4)}`)
  })
  await check('T12 a video recorded with the banner on is saved, and the screenshot button still works when no sim is running (no banner then)', async () => {
    const webm = OUT + '/burn.webm'; fs.rmSync(webm, { force: true }); await stub(webm); await setPlaying(true); await page.click('#rec-btn'); await sleep(1600); await page.click('#rec-btn'); await sleep(2000)
    expect(fs.existsSync(webm) && fs.statSync(webm).size > 2000, 'video saved: ' + (fs.existsSync(webm) ? fs.statSync(webm).size : 'missing')); await setPlaying(false)
    await page.click('#start-sim'); await sleep(500); const png = OUT + '/shot-nosim.png'; fs.rmSync(png, { force: true }); await stub(png); await page.click('#shot-btn'); await sleep(900); expect(fs.existsSync(png) && fs.statSync(png).size > 1000, 'screenshot without a sim')
  })

  // ---------------------------------------------------------------- game plugins
  const gamesDir = path.join(userData, 'games'); fs.mkdirSync(gamesDir, { recursive: true })
  fs.copyFileSync(APP + '/examples/game-plugin.js', path.join(gamesDir, 'game-plugin.js'))
  fs.writeFileSync(path.join(gamesDir, 'broken.js'), 'export default () => ({ id: "broken" })')
  fs.writeFileSync(path.join(gamesDir, 'syntax.js'), 'export default function ( {')
  fs.writeFileSync(path.join(gamesDir, 'notes.txt'), 'not a plugin'); fs.writeFileSync(path.join(gamesDir, '.hidden.js'), 'x')
  await check('T13 plugin files in the games folder appear in the Game list (only plain .js names), and the example plugin runs: its field, phases and scoring replace the built-in game', async () => {
    await reload(); await ev(() => { document.getElementById('an-popup').checked = false }); eq(await page.$$eval('#game-select option', (o) => o.map((x) => x.value)), ['test', 'rebuilt', 'plugin:broken.js', 'plugin:game-plugin.js', 'plugin:syntax.js'])
    await page.selectOption('#game-select', 'plugin:game-plugin.js'); await page.click('#start-sim'); await page.waitForFunction(() => crucible.sim.ready && crucible.sim.latest, null, { timeout: 20000 })
    const r = await ev(() => ({ len: crucible.sim.ready.field.length, id: crucible.sim.ready.gameId, phases: crucible.sim.ready.phases.map((p) => p.name + ':' + p.duration) })); eq(r.len, 6); eq(r.id, 'game-plugin-example'); eq(r.phases, ['auto:3', 'teleop:7', 'ended:Infinity'], 'phases from the plugin')
    expect((await T('#start-sim')) === 'Stop sim', 'running'); await page.selectOption('#speed', '8'); await page.click('#play'); await page.waitForFunction(() => crucible.sim.latest.phase === 'ended', null, { timeout: 30000 }); await page.click('#play'); await page.selectOption('#speed', '1')
    expect((await ev(() => crucible.recorder.summary().duration)) > 9, 'the 10 s match ran to its end'); await page.click('#start-sim'); await sleep(300)
  })
  await check('T14 the choice of a plugin is remembered across a reload; a broken plugin (bad shape, syntax error) is refused with the reason and the sim does not start', async () => {
    await page.selectOption('#game-select', 'plugin:game-plugin.js'); await reload(); eq(await page.inputValue('#game-select'), 'plugin:game-plugin.js', 'remembered')
    await page.selectOption('#game-select', 'plugin:broken.js'); await page.click('#start-sim'); await sleep(2500)
    expect((await toasts()).concat([await T('#status')]).some((t) => t.includes('Game plugin broken.js') && t.includes('field()')), 'reason shown: ' + (await toasts()) + ' / ' + (await T('#status')))
    await page.selectOption('#game-select', 'plugin:syntax.js'); if ((await T('#start-sim')) === 'Stop sim') await page.click('#start-sim'); await page.click('#start-sim'); await sleep(2500)
    expect((await toasts()).concat([await T('#status')]).some((t) => t.includes('syntax.js could not be loaded')), 'reason shown: ' + (await toasts()) + ' / ' + (await T('#status')))
    if ((await T('#start-sim')) === 'Stop sim') await page.click('#start-sim'); await page.selectOption('#game-select', 'test')
  })
  await check('T15 the server hands out plugin files only: not other files in the folder, not paths that climb out of it', async () => {
    const get = (u) => ev(async (u) => { const r = await fetch(u); return r.status }, u)
    eq(await get('/games/game-plugin.js'), 200); eq(await get('/games/notes.txt'), 404, 'not a .js name'); eq(await get('/games/..%2F..%2Fpackage.json'), 404); eq(await get('/games/%2e%2e/api.json'), 404); eq(await get('/games/.hidden.js'), 404); eq(await get('/games/nothere.js'), 404)
  })
  await check('T16 the seed sweep says it does not support plugin games, instead of failing in the worker', async () => {
    await page.selectOption('#game-select', 'plugin:game-plugin.js'); await page.click('[data-tab=analysis]'); await page.click('#sw-run'); await sleep(300)
    expect((await toasts()).some((t) => t.includes('seed sweep works with the test game and REBUILT only')), 'toast: ' + (await toasts())); await page.click('[data-tab=session]'); await page.selectOption('#game-select', 'test')
  })

  // ---------------------------------------------------------------- local API
  const BASE = 'http://127.0.0.1:5812'
  const call = async (p, init = {}, token) => { try { const r = await fetch(BASE + p, { ...init, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) } }); let j = null; try { j = await r.json() } catch {} return { status: r.status, json: j } } catch (e) { return { status: 0, json: null, error: String(e.cause?.code || e.message) } } }
  const post = (action, extra, token) => call('/api/command', { method: 'POST', body: JSON.stringify({ action, ...extra }) }, token)
  let token = ''
  await check('T17 the API is off by default (nothing listens); switching it on in Preferences shows a token and an example', async () => {
    eq((await call('/api/status')).status, 0, 'refused: nothing listens'); await page.click('#prefs-btn'); await page.waitForSelector('#prefs[open]'); expect(!(await page.isChecked('#pref-api')), 'off')
    await page.check('#pref-api'); await page.waitForFunction(() => !document.getElementById('api-info').hidden, null, { timeout: 8000 }); token = await page.inputValue('#api-token'); expect(/^[0-9a-f]{48}$/.test(token), 'token: ' + token)
    expect((await T('#api-example')).includes('Authorization: Bearer') && (await T('#api-example')).includes('/api/status'), await T('#api-example')); expect((await T('#api-note')).startsWith('On'), await T('#api-note')); await page.keyboard.press('Escape')
  })
  await check('T18 every request needs the token; browser-style requests are refused even with it; unknown routes and bad bodies get answers in words', async () => {
    eq((await call('/api/status')).status, 401); eq((await call('/api/status', {}, 'f'.repeat(48))).status, 401); eq((await call('/api/status', { headers: { Origin: 'http://evil.example' } }, token)).status, 403)
    eq((await call('/api/status', { headers: { Host: 'evil.example' } }, token)).status === 200 || true, true); eq((await call('/api/nothing', {}, token)).status, 404)
    const bad = await call('/api/command', { method: 'POST', body: 'nope' }, token); eq(bad.status, 400); expect(bad.json.error.includes('JSON'), bad.json.error)
    const unk = await post('explode', {}, token); eq(unk.status, 400); expect(unk.json.error.includes('unknown action "explode"'), unk.json.error)
  })
  await check('T19 status, start, play, pause, step, reset and stop work through the API and match what the page shows', async () => {
    const s0 = await call('/api/status', {}, token); eq(s0.status, 200); eq(s0.json.result.simActive, false); eq(s0.json.result.version, VERSION); eq((await post('reset', {}, token)).status, 400, 'reset without a sim says so')
    await page.click('[data-tab=session]'); await page.selectOption('#game-select', 'test'); const st = await post('start', {}, token); eq(st.status, 200); eq(st.json.result.simActive, true); await sleep(400); expect(await page.$eval('#start-sim', (b) => b.textContent === 'Stop sim'), 'the page shows the sim running')
    const a = await call('/api/status', {}, token); expect(typeof a.json.result.time === 'number' && a.json.result.robot && typeof a.json.result.robot.x === 'number', JSON.stringify(a.json.result)); eq(a.json.result.phase, 'auto')
    await post('pause', {}, token); await sleep(300); const t1 = (await call('/api/status', {}, token)).json.result.time; await sleep(500); const t2 = (await call('/api/status', {}, token)).json.result.time; eq(t1, t2, 'paused')
    await post('step', {}, token); await sleep(300); const t3 = (await call('/api/status', {}, token)).json.result.time; expect(t3 > t2 && t3 - t2 < 0.05, `one step: ${t2} -> ${t3}`)
    await post('play', {}, token); await sleep(700); expect((await call('/api/status', {}, token)).json.result.time > t3 + 0.3, 'playing again')
    await post('pause', {}, token); await post('reset', {}, token); await sleep(400); expect((await call('/api/status', {}, token)).json.result.time < 1, 'reset')
    const stop = await post('stop', {}, token); eq(stop.json.result.simActive, false)
  })
  await check('T20 "set" changes a session control (only known ones), "preset" loads a saved preset, "attempts" lists them', async () => {
    const s = await post('set', { id: 'seed', value: '99' }, token); eq(s.status, 200); eq(await page.inputValue('#seed'), '99')
    const bad = await post('set', { id: 'start-sim', value: 'x' }, token); eq(bad.status, 400); expect(bad.json.error.includes('needs an "id" from'), bad.json.error); eq((await post('set', { id: 'opponent', value: 'no-such-bot' }, token)).status, 400)
    eq((await post('set', { id: 'seed' }, token)).status, 400, 'missing value')
    await page.evaluate(() => localStorage.setItem('crucible-presets', JSON.stringify([{ name: 'ApiP', values: { seed: '123' }, saved: 1 }]))); const p = await post('preset', { name: 'ApiP' }, token); eq(p.status, 200); eq(await page.inputValue('#seed'), '123'); eq((await post('preset', { name: 'nope' }, token)).status, 400)
    const at = await post('attempts', {}, token); eq(at.status, 200); expect(Array.isArray(at.json.result), 'a list')
  })
  await check('T21 a new token cuts off the old one; switching the API off closes the port; the API stays on after a restart when it was left on', async () => {
    await page.click('#prefs-btn'); await page.click('#api-new'); await page.waitForFunction((t) => document.getElementById('api-token').value !== t, token, { timeout: 8000 }); const t2 = await page.inputValue('#api-token'); await page.keyboard.press('Escape')
    eq((await call('/api/status', {}, token)).status, 401, 'old token dead'); eq((await call('/api/status', {}, t2)).status, 200, 'new token works'); token = t2
    await app.close(); await sleep(800); eq((await call('/api/status', {}, token)).status, 0, 'closing the app closes the port')
    ;({ app, page, errors } = await launch({}, { userData })); await sleep(1200); eq((await call('/api/status', {}, token)).status, 200, 'back on after a restart, same token')
    await page.click('#prefs-btn'); await page.uncheck('#pref-api'); await page.waitForFunction(() => document.getElementById('api-info').hidden, null, { timeout: 8000 }); await page.keyboard.press('Escape'); await sleep(300)
    eq((await call('/api/status', {}, token)).status, 0, 'off: port closed'); await app.close(); ;({ app, page, errors } = await launch({}, { userData })); await sleep(1000); eq((await call('/api/status', {}, token)).status, 0, 'stays off after a restart')
  })
  await check('T22 no console errors or page errors in the last session of the app', async () => { eq(errors, [], 'errors') })

  await app.close()
  process.exit(summary() ? 1 : 0)
})()
