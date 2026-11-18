const fs = require('fs')
const { check, expect, eq, sleep, summary, launch, sh } = require('./lib')
const SP = process.env.SP
const FAKE = SP + '/fakerobot'
const CFG = require('path').resolve(__dirname, '..', 'crucible.config.json')
const setMode = (m) => fs.writeFileSync(FAKE + '/mode.txt', m)
const logText = (page) => page.$$eval('#robot-log .ln', (els) => els.map((e) => e.textContent))
const alive = (pid) => { const st = sh(`ps -o stat= -p ${pid}`); return st !== '' && !st.startsWith('Z') } // a zombie is dead

;(async () => {
  try { fs.unlinkSync(CFG) } catch {}
  const { app, page, errors } = await launch()

  await check('A1 window title, splash gone, no page errors', async () => {
    eq(await page.title(), 'BALTA Crucible')
    await page.waitForFunction(() => { const s = document.getElementById('splash'); return !s || s.hidden || getComputedStyle(s).display === 'none' || getComputedStyle(s).opacity === '0' || !s.isConnected }, null, { timeout: 8000 })
    expect(errors.length === 0, errors.join(' | '))
  })
  await check('A2 version label shown', async () => { expect(/^v\d+\.\d+\.\d+/.test(await page.textContent('#app-version'))) })
  await check('A3 Launch robot visible in the desktop app, Session no longer has it', async () => {
    expect(!(await page.$eval('#launch-robot', (e) => e.hidden)))
    eq(await page.$eval('#tab-session #launch-robot', () => 1).catch(() => 0), 0)
    expect(await page.$eval('#tab-robot #launch-robot', () => 1))
  })

  await check('B1 tabs switch panels, aria-selected and sidebar width', async () => {
    const st = async () => page.evaluate(() => ({
      session: !document.getElementById('tab-session').hidden, robot: !document.getElementById('tab-robot').hidden, topics: !document.getElementById('tab-topics').hidden,
      w: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      sel: [...document.querySelectorAll('.tab')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.tab),
    }))
    eq(await st(), { session: true, robot: false, topics: false, w: 344, sel: ['session'] }, 'initial')
    await page.click('[data-tab=robot]'); eq(await st(), { session: false, robot: true, topics: false, w: 460, sel: ['robot'] }, 'robot')
    await page.click('[data-tab=topics]'); eq(await st(), { session: false, robot: false, topics: true, w: 344, sel: ['topics'] }, 'topics')
    await page.click('[data-tab=session]'); eq(await st(), { session: true, robot: false, topics: false, w: 344, sel: ['session'] }, 'back')
  })
  await check('B2 Session card shows mode hint; mode select lives on Robot tab', async () => {
    eq(await page.$eval('#sim-mode', (e) => !!e.closest('#tab-robot')), true)
    expect((await page.textContent('#sim-mode-hint')).includes('scripted robot'))
  })
  await check('B3 NT host boxes stay in sync both ways', async () => {
    await page.fill('#host', '10.0.0.5')
    await page.click('[data-tab=robot]'); eq(await page.inputValue('#robot-host'), '10.0.0.5')
    await page.fill('#robot-host', 'roborio.local')
    await page.click('[data-tab=session]'); eq(await page.inputValue('#host'), 'roborio.local')
    await page.fill('#host', '127.0.0.1')
  })

  await page.click('[data-tab=robot]')
  await check('C1 Launch with no robot project: clear error, button stays Launch', async () => {
    await page.selectOption('#sim-mode', 'robot')
    await page.click('#launch-robot'); await sleep(500)
    expect((await page.textContent('#notice')).includes('Robot project not found'), await page.textContent('#notice'))
    eq(await page.textContent('#launch-robot'), 'Launch robot')
    const lines = await logText(page)
    expect(lines.some((l) => l.includes('Robot project not found')), 'error is also in the log: ' + lines.join('|'))
    expect((await page.textContent('#robot-state')).includes('not running'), await page.textContent('#robot-state'))
  })
  await page.click('#log-clear')

  fs.writeFileSync(CFG, JSON.stringify({ robotDir: FAKE }))
  setMode('normal')
  let pid
  await check('C2 Launch (real time): output streams into the log, env + args right, button flips', async () => {
    await page.selectOption('#sim-mode', 'robot')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('BUILD SUCCESSFUL'), null, { timeout: 8000 })
    const lines = await logText(page)
    expect(lines.some((l) => l === '> Task :compileJava'))
    expect(lines.some((l) => l.includes('simulateJava --no-daemon --console=plain')), 'args line missing')
    expect(lines.some((l) => l.includes('CRUCIBLE_BRIDGE=1 CRUCIBLE_MODE=unset')), 'env wrong: ' + lines.filter((l) => l.includes('CRUCIBLE')).join('|'))
    eq(await page.textContent('#launch-robot'), 'Stop robot')
    expect((await page.textContent('#robot-state')).includes('running (real time)'), await page.textContent('#robot-state'))
    pid = fs.readFileSync(FAKE + '/pid.txt', 'utf8').trim()
    expect(alive(pid), 'process should be alive')
  })
  await check('C3 severity colors: error red, warn gold, ok green, system gold', async () => {
    const cls = await page.$$eval('#robot-log .ln', (els) => Object.fromEntries(els.map((e) => [e.textContent.slice(0, 20), e.className])))
    expect(cls['WARNING: Driver Stat'] === 'ln warn', JSON.stringify(cls))
    expect(cls['ERROR: something wen'] === 'ln error')
    expect(cls['BUILD SUCCESSFUL in '] === 'ln ok')
    expect(Object.values(cls).some((c) => c === 'ln sys'))
    const col = await page.$$eval('#robot-log .ln.error, #robot-log .ln.ok', (els) => els.map((e) => getComputedStyle(e).color))
    expect(new Set(col).size === 2, 'error and ok should differ in color: ' + col)
  })
  await check('C4 stderr line and stack frame both captured', async () => {
    const lines = await logText(page)
    expect(lines.some((l) => l.includes('ERROR: something went wrong')))
    expect(lines.some((l) => l.includes('at frc.robot.Robot.robotInit')))
  })
  await check('C5 mode change while running shows relaunch hint', async () => {
    await page.selectOption('#sim-mode', 'lockstep')
    expect((await page.textContent('#robot-state')).includes('stop and launch again'), await page.textContent('#robot-state'))
    await page.selectOption('#sim-mode', 'robot')
    expect((await page.textContent('#robot-state')).includes('running (real time)'))
  })
  await check('C6 Stop kills the whole process tree and says so', async () => {
    const child = fs.readFileSync(FAKE + '/child.txt', 'utf8').trim()
    expect(alive(child), 'background child should be alive before stop')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 8000 })
    await sleep(500)
    expect(!alive(pid), 'main process still alive')
    expect(!alive(child), 'child process survived Stop (tree not killed)')
    const lines = await logText(page)
    expect(lines.some((l) => l.includes('[stopping robot sim]')))
    expect(lines.some((l) => l.includes('[robot sim exited with code')), lines.slice(-4).join('|'))
  })
  await check('C7 Launch in lockstep mode sets CRUCIBLE_MODE=lockstep', async () => {
    await page.click('#log-clear')
    await page.selectOption('#sim-mode', 'lockstep')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('CRUCIBLE_MODE='), null, { timeout: 8000 })
    const lines = await logText(page)
    expect(lines.some((l) => l.includes('CRUCIBLE_BRIDGE=1 CRUCIBLE_MODE=lockstep')), lines.join('|'))
    expect((await page.textContent('#robot-state')).includes('lockstep'))
    await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot')
  })
  await check('C8 process exits by itself with code 3: logged, button resets', async () => {
    await page.click('#log-clear'); setMode('exit3')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('exited with code 3'), null, { timeout: 8000 })
    eq(await page.textContent('#launch-robot'), 'Launch robot')
    expect((await page.textContent('#notice')).includes('exited (3)'))
    const lines = await logText(page); expect(lines.some((l) => l === 'BUILD FAILED in 1s'))
    expect(await page.$eval('#robot-log .ln.error', (e) => e.textContent.startsWith('BUILD FAILED')))
  })
  await check('C9 last line without trailing newline is not lost', async () => {
    await page.click('#log-clear'); setMode('partial')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('exited with code'), null, { timeout: 8000 })
    const lines = await logText(page)
    expect(lines.some((l) => l.includes('last words without newline')), 'LOST: ' + lines.join('|'))
  })
  await check('C10 ANSI color codes in output', async () => {
    await page.click('#log-clear'); setMode('ansi')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('and plain'), null, { timeout: 8000 })
    const t = (await logText(page)).find((l) => l.includes('and plain'))
    await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot')
    expect(t === 'red text and plain', 'ANSI codes should be stripped, got ' + JSON.stringify(t))
  })
  await check('C11 very long line wraps without horizontal overflow', async () => {
    await page.click('#log-clear'); setMode('long')
    await page.click('#launch-robot')
    try {
      // a busy runner starts the program late (a Java version check comes first): wait for the line, not for a fixed time
      await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('LLLL'), null, { timeout: 40000 })
        .catch(async (e) => { throw new Error('the long line never reached the log: ' + e.message.split('\n')[0] + ' | button "' + (await page.textContent('#launch-robot')) + '", status "' + (await page.textContent('#robot-state')) + '", log starts: ' + JSON.stringify((await page.textContent('#robot-log')).slice(0, 300))) })
      const o = await page.$eval('#robot-log', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth }))
      expect(o.sw <= o.cw + 2, JSON.stringify(o))
    } finally {
      // this program sleeps for ten minutes: a failure above must not leave it running into the next check
      if ((await page.textContent('#launch-robot')) === 'Stop robot') await page.click('#launch-robot')
      await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 20000 })
    }
  })
  await check('C12 double-click on Launch starts exactly one process', async () => {
    // start from "not running", whatever the check before left behind
    if ((await page.textContent('#launch-robot')) === 'Stop robot') { await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 20000 }) }
    await page.click('#log-clear'); setMode('slow')
    await page.dblclick('#launch-robot'); await sleep(2500)
    const n = Number(sh('pgrep -fc "[b]ash ./gradlew simulateJava"') || 0)
    const state = await page.textContent('#launch-robot')
    sh('pkill -f "[g]radlew simulateJava"')
    await sleep(500)
    expect(n === 1 && state === 'Stop robot', `process count ${n}, button "${state}"`)
  })
  await sleep(1000)
  await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 8000 }).catch(async () => { await page.click('#launch-robot') })

  await check('D1 flood of 20000 lines: capped at 5000, newest kept, UI responsive', async () => {
    await page.click('#log-clear'); setMode('flood')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('flood line 20000'), null, { timeout: 30000 })
    await sleep(500)
    const lines = await logText(page)
    expect(lines.length === 5000, 'rows ' + lines.length)
    expect(lines[lines.length - 1].startsWith('flood line 20000'), 'last: ' + lines[lines.length - 1])
    expect(!lines.some((l) => l === 'flood line 1'), 'oldest line should be dropped')
    expect((await page.textContent('#log-count')) === '5000 lines', await page.textContent('#log-count'))
    const t0 = Date.now(); await page.click('[data-tab=topics]'); await page.click('[data-tab=robot]'); expect(Date.now() - t0 < 1500 * Math.max(1, Number(process.env.E2E_SLOW) || 1), 'UI sluggish after flood: ' + (Date.now() - t0) + ' ms')
    const bottom = await page.$eval('#robot-log', (e) => e.scrollHeight - e.scrollTop - e.clientHeight)
    expect(bottom < 30, 'follow should keep the bottom in view, off by ' + bottom)
  })
  await check('D2 scroll up stops Follow, new lines do not yank, scroll down resumes', async () => {
    await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot')
    await page.click('#log-clear'); setMode('slow')
    await page.click('#launch-robot')
    await page.waitForFunction(() => document.querySelectorAll('#robot-log .ln').length > 60, null, { timeout: 15000 })
    await page.$eval('#robot-log', (e) => { e.scrollTop = 0 })
    await sleep(400)
    eq(await page.$eval('#log-follow', (e) => e.checked), false, 'follow unchecked after scrolling up')
    const top1 = await page.$eval('#robot-log', (e) => e.scrollTop); await sleep(800)
    const top2 = await page.$eval('#robot-log', (e) => e.scrollTop)
    expect(top2 === top1 && top1 < 5, 'view was yanked: ' + top1 + ' -> ' + top2)
    await page.$eval('#robot-log', (e) => { e.scrollTop = e.scrollHeight }); await sleep(400)
    eq(await page.$eval('#log-follow', (e) => e.checked), true, 'follow re-checked at bottom')
    // ticking Follow again jumps to the end
    await page.$eval('#robot-log', (e) => { e.scrollTop = 0 }); await sleep(300)
    await page.check('#log-follow'); await sleep(300)
    expect(await page.$eval('#robot-log', (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30), 'ticking Follow should jump to the newest line')
  })
  await check('D3 filter narrows rows live, case-insensitive, count says x of y, new lines respect filter', async () => {
    await page.fill('#log-filter', 'TICK 1')
    await sleep(300)
    const n1 = (await logText(page)).length
    expect(n1 > 0 && (await logText(page)).every((l) => l.toLowerCase().includes('tick 1')), 'rows not all matching')
    expect(/^\d+ of \d+ lines$/.test(await page.textContent('#log-count')), await page.textContent('#log-count'))
    await sleep(1500)
    expect((await logText(page)).every((l) => l.toLowerCase().includes('tick 1')), 'new lines ignoring filter')
    await page.fill('#log-filter', 'zzzz-none'); await sleep(200); eq((await logText(page)).length, 0, 'no match shows none')
    await page.fill('#log-filter', ''); await sleep(300)
    expect((await logText(page)).length > n1)
  })
  await check('D4 Copy puts shown lines on the clipboard', async () => {
    await page.fill('#log-filter', 'tick 2'); await sleep(200)
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.click('#log-copy'); await sleep(400)
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    const notice = await page.textContent('#notice')
    await page.fill('#log-filter', '')
    expect(clip.includes('tick 2') && !clip.includes('tick 1\n'), 'clipboard: ' + JSON.stringify(clip.slice(0, 60)) + ' notice: ' + notice)
  })
  await check('D5 Save writes a text file with the shown lines', async () => {
    const out = SP + '/e2e/saved-log.txt'; try { fs.unlinkSync(out) } catch {}
    await app.evaluate(({ session }, p) => { session.defaultSession.on('will-download', (_e, item) => item.setSavePath(p)) }, out)
    await page.fill('#log-filter', 'tick 3'); await sleep(200)
    await page.click('#log-save'); await sleep(1500)
    await page.fill('#log-filter', '')
    expect(fs.existsSync(out), 'no file written')
    const t = fs.readFileSync(out, 'utf8'); expect(t.includes('tick 3') && !t.includes('tick 4'), t.slice(0, 80))
    return 'file written when a save path is provided; the real Electron prompt (native dialog) cannot be driven here'
  })
  await check('D6 Clear empties the log and count', async () => { await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot'); await sleep(400); await page.click('#log-clear'); await sleep(200); eq((await logText(page)).length, 0); eq(await page.textContent('#log-count'), '0 lines') })

  await check('E1 closing the app while the robot runs kills it', async () => {
    setMode('normal'); await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('robot-log').textContent.includes('BUILD SUCCESSFUL'), null, { timeout: 8000 })
    const pid2 = fs.readFileSync(FAKE + '/pid.txt', 'utf8').trim()
    expect(alive(pid2), 'robot should still be running')
    await app.close(); await sleep(1500)
    expect(!alive(pid2), 'robot process orphaned after app quit')
  })
  try { fs.unlinkSync(CFG) } catch {}
  sh('pkill -f "gradlew simulateJava"')
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); try { fs.unlinkSync(require('path').resolve(__dirname, '..', 'crucible.config.json')) } catch {}; process.exit(1) })
