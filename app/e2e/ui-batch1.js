const fs = require('fs')
const { check, expect, eq, sleep, summary, launch, sh } = require('./lib')
const SP = process.env.SP
const FAKE = SP + '/fakerobot'; const CFG = require('path').resolve(__dirname, '..', 'crucible.config.json')
const setMode = (m) => fs.writeFileSync(FAKE + '/mode.txt', m)
const alive = (pid) => { const st = sh(`ps -o stat= -p ${pid}`); return st !== '' && !st.startsWith('Z') }
;(async () => {
  try { fs.unlinkSync(CFG) } catch {}
  const { app, page, errors } = await launch()
  const T = (id) => page.textContent(id)
  const logLines = () => page.$$eval('#robot-log .ln', (els) => els.map((e) => e.textContent))
  const phase = () => T('#run-phase')
  const idle = () => page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot' && !document.getElementById('run-bar').offsetParent, null, { timeout: 10000 })
  const stopIfRunning = async () => { if ((await T('#launch-robot')) === 'Stop robot') { await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 10000 }); await sleep(300) } }
  await page.click('[data-tab=robot]')

  // ---------- run status
  await check('X1 status line before anything: Not running, no bar, no Relaunch, dim dot', async () => {
    eq(await phase(), 'Not running'); expect(await page.$eval('#run-bar', (e) => e.hidden)); expect(await page.$eval('#relaunch-robot', (e) => e.hidden)); eq(await T('#run-time'), '')
    expect(!(await page.$eval('#run-dot', (e) => e.className.includes('ok') || e.className.includes('bad') || e.className.includes('busy'))), 'dot should be dim')
  })
  await check('X2 launch with no robot project: "Could not start", red dot, no bar', async () => {
    await page.selectOption('#sim-mode', 'robot'); await page.click('#launch-robot'); await sleep(600)
    eq(await phase(), 'Could not start'); expect(await page.$eval('#run-dot', (e) => e.classList.contains('bad')), 'red dot'); expect(await page.$eval('#run-bar', (e) => e.hidden))
    eq(await T('#launch-robot'), 'Launch robot')
  })
  fs.writeFileSync(CFG, JSON.stringify({ robotDir: FAKE }))
  await check('X3 a slow build shows Starting → Building (n tasks) with the moving bar and gold pulsing dot, then Running with green dot', async () => {
    setMode('build'); await page.click('#log-clear'); await page.click('#launch-robot')
    await page.waitForFunction(() => /Building/.test(document.getElementById('run-phase').textContent), null, { timeout: 6000 })
    expect(!(await page.$eval('#run-bar', (e) => e.hidden)), 'bar visible while building'); expect(await page.$eval('#run-dot', (e) => e.classList.contains('busy')), 'busy dot')
    expect(/Building… \(\d tasks\)|Building…/.test(await phase()), await phase())
    await page.waitForFunction(() => /^Running/.test(document.getElementById('run-phase').textContent), null, { timeout: 10000 })
    expect(await page.$eval('#run-bar', (e) => e.hidden), 'bar hidden once running'); expect(await page.$eval('#run-dot', (e) => e.classList.contains('ok')), 'green dot')
    eq(await phase(), 'Running · waiting for the sim')
    expect(!(await page.$eval('#relaunch-robot', (e) => e.hidden)), 'Relaunch visible while running')
  })
  await check('X4 elapsed timer counts up while running and freezes after exit', async () => {
    const a = await T('#run-time'); await sleep(2200); const b = await T('#run-time')
    expect(a !== b && /^\d+ s$/.test(b), `timer ${a} -> ${b}`)
    await page.click('#launch-robot'); await idle(); await sleep(300)
    const f1 = await T('#run-time'); await sleep(1300); eq(await T('#run-time'), f1, 'frozen after exit')
  })
  await check('X5 Stop shows "Stopped" (not Failed) and hides Relaunch', async () => {
    eq(await phase(), 'Stopped'); expect(await page.$eval('#relaunch-robot', (e) => e.hidden))
  })
  await check('X6 non-zero exit shows Failed (exit code 3); build failure shows its label', async () => {
    setMode('exit3'); await page.click('#launch-robot'); await page.waitForFunction(() => /Failed|Build failed/.test(document.getElementById('run-phase').textContent), null, { timeout: 8000 })
    expect(/Failed \(exit code 3\)|Build failed/.test(await phase()), await phase()); expect(await page.$eval('#run-dot', (e) => e.classList.contains('bad')))
    setMode('buildfail'); await page.click('#launch-robot'); await page.waitForFunction(() => /Failed|Build failed/.test(document.getElementById('run-phase').textContent) && document.getElementById('run-phase').textContent.includes('1'), null, { timeout: 8000 })
    eq(await phase(), 'Failed (exit code 1)')
  })
  await check('X7 clean exit (code 0) shows Exited', async () => { setMode('partial'); await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('run-phase').textContent === 'Exited', null, { timeout: 8000 }) })

  await check('X8 Relaunch: new process, one new run, not left "Stopped"', async () => {
    setMode('build'); await page.click('#log-clear'); await page.click('#launch-robot')
    await page.waitForFunction(() => /^Running/.test(document.getElementById('run-phase').textContent), null, { timeout: 12000 })
    const pid1 = fs.readFileSync(FAKE + '/pid.txt', 'utf8').trim()
    await page.click('#relaunch-robot')
    await page.waitForFunction(() => /Building|Starting/.test(document.getElementById('run-phase').textContent), null, { timeout: 12000 })
    await page.waitForFunction(() => /^Running/.test(document.getElementById('run-phase').textContent), null, { timeout: 15000 })
    await sleep(800)
    eq(await T('#launch-robot'), 'Stop robot'); expect(/^Running/.test(await phase()), 'stale exit must not end the new run: ' + (await phase()))
    const pid2 = fs.readFileSync(FAKE + '/pid.txt', 'utf8').trim()
    expect(pid1 !== pid2, 'a new process should run'); expect(!alive(pid1), 'old process must be gone'); expect(alive(pid2), 'new process alive')
    const lines = await logLines(); expect(lines.filter((l) => l.startsWith('[launching robot sim')).length === 2, 'two launches logged')
    expect(lines.some((l) => l.includes('[stopping robot sim]')))
  })
  await check('X9 Relaunch with robot not running is unavailable (hidden)', async () => { await stopIfRunning(); expect(await page.$eval('#relaunch-robot', (e) => e.hidden)) })

  // ---------- auto-sim
  await check('X10 "Also start the sim": Launch also starts the sim (robot mode) and status turns "waiting for the sim"', async () => {
    await page.check('#auto-sim'); setMode('build'); await page.selectOption('#sim-mode', 'robot'); await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('start-sim').textContent === 'Stop sim', null, { timeout: 15000 })
    await page.waitForFunction(() => /^Running/.test(document.getElementById('run-phase').textContent), null, { timeout: 12000 })
    await page.click('[data-tab=session]'); await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 10000 }); await sleep(600)
    expect((await T('#status')).includes('robot code'), await T('#status'))
    const link = (await page.$$eval('.simhud .kv', (rs) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]))))['Robot program']
    const all = await page.$$eval('.simhud .kv', (rs) => rs.map((r) => r.querySelector('.k').textContent + '=' + r.querySelector('.v').textContent))
    expect(link === 'waiting for it…', 'rows: ' + JSON.stringify(all)); eq(await phase(), 'Running · waiting for the sim')
    await page.click('#start-sim'); await page.click('[data-tab=robot]'); await stopIfRunning()
  })
  await check('X11 auto-sim does not start a sim for the scripted mode, nor restarts one already running', async () => {
    if ((await T('#start-sim')) === 'Stop sim') await page.click('#start-sim'); await page.click('[data-tab=robot]'); await stopIfRunning()
    await page.selectOption('#sim-mode', 'script'); setMode('slow'); await page.click('#launch-robot'); await sleep(1500)
    eq(await T('#start-sim'), 'Start sim', 'scripted mode: no sim'); await stopIfRunning()
    await page.selectOption('#sim-mode', 'robot'); await page.click('[data-tab=session]'); await page.click('#start-sim'); await sleep(500)
    const h = await page.$eval('#sim-step', (e) => e.disabled)
    await page.click('[data-tab=robot]'); await page.click('#launch-robot'); await sleep(1200)
    eq(await T('#start-sim'), 'Stop sim', 'still the one running sim (not toggled off)'); await stopIfRunning()
    await page.click('[data-tab=session]'); await page.click('#start-sim'); await page.uncheck('#auto-sim', { force: true }).catch(() => {}); await page.click('[data-tab=robot]'); await page.uncheck('#auto-sim')
  })

  // ---------- error navigation + level toggles
  await check('X12 error buttons: counts blocks (stack traces count once), disabled at zero', async () => {
    if ((await T('#start-sim')) === 'Stop sim') await page.click('#start-sim'); await page.click('[data-tab=robot]'); await stopIfRunning()
    await page.click('#log-clear'); await sleep(200)
    expect(await page.$eval('#err-next', (e) => e.disabled) && await page.$eval('#err-prev', (e) => e.disabled), 'disabled with no errors'); eq(await T('#err-count'), '0 errors')
    setMode('errors'); await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('tail filler 30'), null, { timeout: 8000 }); await sleep(300)
    eq(await T('#err-count'), '3 errors', 'blocks: first problem(+2 frames), second problem, Exception(+1 frame)')
    expect(await page.$eval('#err-count', (e) => e.classList.contains('has')), 'red count')
    expect(!(await page.$eval('#err-next', (e) => e.disabled)))
  })
  const focusedErr = async () => { const m = /^Error (\d) of 3$/.exec(await T('#notice')); return m ? Number(m[1]) : null }
  const flashText = () => page.$$eval('#robot-log .ln.flash', (es) => es.map((e) => e.textContent))
  await check('X13 Next/Previous jump to each error block, scroll it into view, wrap around, and stop Follow', async () => {
    const seen = []
    for (let i = 0; i < 4; i++) { await page.click('#err-next'); await sleep(150); seen.push(await focusedErr()) }
    eq(seen, [1, 2, 3, 1], 'forward with wrap (error numbers)')
    eq(await page.$eval('#log-follow', (e) => e.checked), false, 'Follow stops when jumping')
    expect((await flashText()).includes('ERROR: first problem'), 'the first error line is highlighted')
    const vis = await page.$$eval('#robot-log .ln.flash', (es) => es.find((e) => e.textContent === 'ERROR: first problem')).then(() => page.$$eval('#robot-log .ln.flash', (es) => es.map((e) => { const r = e.getBoundingClientRect(), b = document.getElementById('robot-log').getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 })).then((v) => v[v.length - 1] !== undefined)) || (async () => 0)
    void vis
    const vis2 = await page.$eval('#robot-log .ln.flash', (e) => { const r = e.getBoundingClientRect(), b = document.getElementById('robot-log').getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 })
    expect(vis2, 'target is inside the visible log area')
    await page.click('#err-prev'); await sleep(150); eq(await focusedErr(), 3, 'previous wraps backwards to the last error')
    await sleep(1400); eq((await flashText()).length, 0, 'highlight fades')
  })
  await check('X14 keys N / Shift+N do the same (and work from another tab)', async () => {
    await page.click('[data-tab=session]'); await sleep(1500); await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('n'); await sleep(250)
    expect(!(await page.$eval('#tab-robot', (e) => e.hidden)), 'switches to the Robot tab'); const a = await focusedErr()
    await page.keyboard.press('Shift+N'); await sleep(250); const b = await focusedErr()
    expect(a !== null && b !== null && a !== b, `n then Shift+N moved: error ${a} / error ${b}`)
  })
  await check('X15 level toggles: hiding Errors/Warnings/Info removes just those lines; BUILD/sys lines stay; counts say x of y', async () => {
    const total = (await logLines()).length
    await page.uncheck('#lv-error'); await sleep(250)
    let l = await logLines(); expect(!l.some((x) => /^ERROR|Exception in|^\s+at /.test(x)), 'errors hidden'); expect(l.some((x) => x.startsWith('WARNING')), 'warning still shown'); expect(/of \d+ lines/.test(await T('#log-count')), await T('#log-count'))
    await page.check('#lv-error'); await page.uncheck('#lv-warn'); await sleep(250)
    l = await logLines(); expect(!l.some((x) => x.startsWith('WARNING')) && l.some((x) => x.startsWith('ERROR')), 'warnings hidden only')
    await page.check('#lv-warn'); await page.uncheck('#lv-info'); await sleep(250)
    l = await logLines(); expect(l.every((x) => !/^filler|^tail filler|^more filler|^line a/.test(x)), 'info hidden'); expect(l.some((x) => x.startsWith('[')), 'app lines (sys) remain'); expect(l.some((x) => x.startsWith('ERROR')))
    await page.check('#lv-info'); await sleep(250); eq((await logLines()).length, total, 'all back'); eq(await T('#log-count'), `${total} lines`)
  })
  await check('X16 level toggles combine with the text filter, and new lines obey both', async () => {
    await page.uncheck('#lv-info'); await page.fill('#log-filter', 'problem'); await sleep(250)
    const l = await logLines(); expect(l.length >= 2 && l.every((x) => /problem/i.test(x)), JSON.stringify(l))
    await page.fill('#log-filter', ''); await page.check('#lv-info'); await sleep(200)
  })
  await stopIfRunning()

  // ---------- settings persistence
  await check('X17 side-panel choices survive a reload: game, mode, opponent, step, seed, host, auto-sim, log levels', async () => {
    await page.click('[data-tab=session]')
    await page.selectOption('#game-select', 'rebuilt'); await page.selectOption('#opponent', 'cycler'); await page.selectOption('#step-dt', '0.005'); await page.fill('#seed', '1234'); await page.fill('#host', '10.2.13.2')
    await page.click('[data-tab=robot]'); await page.selectOption('#sim-mode', 'lockstep'); await page.check('#auto-sim'); await page.uncheck('#lv-warn')
    await page.reload(); await page.waitForSelector('#start-sim')
    const v = await page.evaluate(() => ({ g: document.getElementById('game-select').value, o: document.getElementById('opponent').value, s: document.getElementById('step-dt').value, seed: document.getElementById('seed').value, host: document.getElementById('host').value, rhost: document.getElementById('robot-host').value, mode: document.getElementById('sim-mode').value, auto: document.getElementById('auto-sim').checked, warn: document.getElementById('lv-warn').checked, err: document.getElementById('lv-error').checked }))
    eq(v, { g: 'rebuilt', o: 'cycler', s: '0.005', seed: '1234', host: '10.2.13.2', rhost: '10.2.13.2', mode: 'lockstep', auto: true, warn: false, err: true })
    expect((await T('#sim-mode-hint')).includes('lockstep'), 'mode hint follows the restored mode')
  })
  await check('X18 a restored setting really takes effect (game + seed used by Start sim)', async () => {
    await page.click('[data-tab=robot]'); await page.selectOption('#sim-mode', 'script'); await page.click('[data-tab=session]'); await page.click('#start-sim')
    await page.waitForFunction(() => document.querySelector('.simhud .kv'), null, { timeout: 15000 })
    const r = await page.$$eval('.simhud .kv', (rs) => rs.map((x) => x.querySelector('.k').textContent)); expect(r.includes('HUBs'), 'REBUILT rows: ' + r)
    await page.click('#start-sim')
  })
  await check('X19 corrupt or outdated saved settings are ignored, not fatal', async () => {
    await page.evaluate(() => localStorage.setItem('crucible-settings', '{not json')); await page.reload(); await page.waitForSelector('#start-sim')
    eq(await page.inputValue('#seed'), '42', 'defaults when JSON is corrupt')
    await page.evaluate(() => localStorage.setItem('crucible-settings', JSON.stringify({ 'game-select': 'chess', seed: 5, 'auto-sim': 'yes', opponent: 'blocker' }))); await page.reload(); await page.waitForSelector('#start-sim')
    const v = await page.evaluate(() => ({ g: document.getElementById('game-select').value, seed: document.getElementById('seed').value, auto: document.getElementById('auto-sim').checked, o: document.getElementById('opponent').value }))
    eq(v, { g: 'test', seed: '42', auto: false, o: 'blocker' }, 'unknown option, wrong types ignored; valid one applied')
    await page.evaluate(() => localStorage.removeItem('crucible-settings')); await page.reload(); await page.waitForSelector('#start-sim')
  })

  // ---------- keyboard shortcuts
  await check('H1 "?" opens the cheat sheet listing every shortcut; Escape and the button close it; help button opens it', async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('?'); expect(await page.$eval('#shortcuts', (d) => d.open), 'opened by ?')
    const n = await page.$$eval('#shortcut-list .sc', (e) => e.length); eq(n, (fs.readFileSync(require('path').resolve(__dirname, '../src/renderer/src/lib/shortcuts.ts'), 'utf8').match(/run: '/g) || []).length, 'one row per shortcut in the table')
    expect((await page.$$eval('#shortcut-list kbd', (e) => e.map((k) => k.textContent))).includes('Ctrl+Enter'), 'key labels')
    await page.screenshot({ path: SP + '/e2e/out/shortcuts.png' })
    await page.keyboard.press('Escape'); await sleep(150); expect(!(await page.$eval('#shortcuts', (d) => d.open)), 'closed by Escape')
    await page.click('#help-btn'); expect(await page.$eval('#shortcuts', (d) => d.open), 'opened by the button'); await page.click('#shortcuts .primary'); expect(!(await page.$eval('#shortcuts', (d) => d.open)))
  })
  await check('H2 tab keys 1/2/3, theme T, panel P work; nothing fires while the sheet is open', async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('2'); expect(!(await page.$eval('#tab-robot', (e) => e.hidden))); await page.keyboard.press('3'); expect(!(await page.$eval('#tab-topics', (e) => e.hidden))); await page.keyboard.press('1'); expect(!(await page.$eval('#tab-session', (e) => e.hidden)))
    const th = await page.evaluate(() => document.documentElement.dataset.theme); await page.keyboard.press('t'); expect((await page.evaluate(() => document.documentElement.dataset.theme)) !== th, 'theme flipped'); await page.keyboard.press('t')
    await page.keyboard.press('?'); await page.keyboard.press('2'); expect(!(await page.$eval('#tab-session', (e) => e.hidden)), 'tab key ignored while the dialog is open'); await page.keyboard.press('Escape')
  })
  await check('H3 sim keys: Ctrl+Enter starts/stops, Space plays/pauses, "." steps 10 ms, Shift+R resets, P folds the panel', async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.getElementById('start-sim').textContent === 'Stop sim', null, { timeout: 15000 }); await page.waitForFunction(() => document.querySelector('.simhud .kv')); await sleep(300)
    const t = async () => Number((await page.$$eval('.simhud .kv', (rs) => Object.fromEntries(rs.map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]))))['Sim time'].replace(' s', ''))
    await page.keyboard.press('.'); await page.waitForFunction(() => { const r = [...document.querySelectorAll('.simhud .kv')].find((x) => x.querySelector('.k').textContent === 'Sim time'); return r && r.querySelector('.v').textContent !== '0.00 s' }, null, { timeout: 15000 }); eq(await t(), 0.01, 'one step = 10 ms')
    await page.keyboard.press(' '); await sleep(1200); expect((await t()) > 0.5, 'Space plays'); eq(await T('#play'), 'Pause')
    await page.keyboard.press(' '); await sleep(300); eq(await T('#play'), 'Play')
    await page.keyboard.press('Shift+R'); await sleep(500); eq(await t(), 0, 'Shift+R resets')
    const was = await page.$eval('.simhud-body', (e) => getComputedStyle(e).display); await page.keyboard.press('p'); await sleep(200)
    expect((await page.$eval('.simhud-body', (e) => getComputedStyle(e).display)) !== was, 'P folds the panel'); await page.keyboard.press('p')
    await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.getElementById('start-sim').textContent === 'Start sim'); 
  })
  await check('H4 plain-key shortcuts do nothing while typing in a box; Ctrl combos still work', async () => {
    await page.click('#seed'); await page.fill('#seed', ''); await page.keyboard.type('123.p?t2')
    eq(await page.inputValue('#seed'), '123.p?t2', 'typed text intact'); expect(!(await page.$eval('#shortcuts', (d) => d.open)), 'no help dialog'); expect(!(await page.$eval('#tab-session', (e) => e.hidden)), 'no tab switch')
    await page.fill('#seed', '42'); await page.click('#seed'); await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.getElementById('start-sim').textContent === 'Stop sim', null, { timeout: 15000 })
    await page.keyboard.press('Control+Enter'); await page.waitForFunction(() => document.getElementById('start-sim').textContent === 'Start sim')
  })
  await check('H5 Ctrl+F focuses the log filter on the Robot tab, Ctrl+L clears the log', async () => {
    await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.press('Control+f'); await sleep(200)
    expect(!(await page.$eval('#tab-robot', (e) => e.hidden)), 'Robot tab shown'); eq(await page.evaluate(() => document.activeElement.id), 'log-filter')
    await page.keyboard.type('abc'); eq(await page.inputValue('#log-filter'), 'abc'); await page.fill('#log-filter', '')
    await page.locator('body').click({ position: { x: 4, y: 4 } }); await page.keyboard.press('Control+l'); await sleep(250); eq((await logLines()).length, 0, 'log cleared')
  })
  await check('H6 driving keys never trigger a shortcut (robot mode would drive, tabs/theme/panel stay put)', async () => {
    await page.click('[data-tab=session]'); await page.locator('body').click({ position: { x: 4, y: 4 } })
    const before = await page.evaluate(() => ({ th: document.documentElement.dataset.theme, tab: !document.getElementById('tab-session').hidden, dlg: document.getElementById('shortcuts').open }))
    for (const k of ['w', 'a', 's', 'd', 'q', 'e', 'j', 'k', 'l', 'h']) { await page.keyboard.down(k); await sleep(40); await page.keyboard.up(k) }
    const after = await page.evaluate(() => ({ th: document.documentElement.dataset.theme, tab: !document.getElementById('tab-session').hidden, dlg: document.getElementById('shortcuts').open }))
    eq(after, before)
  })
  await check('Z1 no unexpected page errors', async () => { const real = errors.filter((e) => !/ERR_CONNECTION_REFUSED/.test(e)); expect(real.length === 0, real.join(' | ')) })
  await app.close().catch(() => {})
  try { fs.unlinkSync(CFG) } catch {}
  sh('pkill -f "[g]radlew simulateJava"')
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); try { fs.unlinkSync(CFG) } catch {}; process.exit(1) })
