// Launcher extras: project picker and recents, project check, extra environment, log source tabs, clickable stack traces, past runs
const fs = require('fs')
const path = require('path')
const { check, expect, eq, sleep, summary, launch, sh } = require('./lib')
const SP = process.env.SP
const FAKE = SP + '/fakerobot'
const CFG = path.resolve(__dirname, '..', 'crucible.config.json')
// the launched projects are copies of the fake one, each with its own mode file
const setMode = (m) => { for (const d of [FAKE, SP + '/proj-plain', SP + '/proj-patched']) { try { fs.writeFileSync(d + '/mode.txt', m) } catch {} } }

function makeProject(dir, { patched }) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(FAKE, dir, { recursive: true })
  if (patched) {
    const lib = path.join(dir, 'src/main/java/frc/robot/lib/simbridge'); fs.mkdirSync(lib, { recursive: true })
    for (const f of ['SimBridge.java', 'EmuSwerve.java', 'EmuTalon.java']) fs.writeFileSync(path.join(lib, f), '')
    fs.writeFileSync(path.join(dir, 'src/main/java/frc/robot/Robot.java'), 'if (RobotBase.isSimulation() && SimBridge.isEnabled()) { }')
    fs.writeFileSync(path.join(dir, 'build.gradle'), 'wpi.sim.addGui().defaultEnabled = !"1".equals(System.getenv("CRUCIBLE_BRIDGE"))')
  }
  return dir
}

;(async () => {
  try { fs.unlinkSync(CFG) } catch {}
  const plain = makeProject(SP + '/proj-plain', { patched: false })
  const patched = makeProject(SP + '/proj-patched', { patched: true })
  fs.writeFileSync(CFG, JSON.stringify({ robotDir: plain }))
  setMode('build')
  const { app, page, errors, userData } = await launch()
  const T = (id) => page.textContent(id)
  const logLines = () => page.$$eval('#robot-log .ln', (els) => els.map((e) => e.textContent))
  await page.click('[data-tab=robot]')
  const pickStub = (result) => app.evaluate(({ dialog }, r) => { dialog.showOpenDialog = async () => r }, result)
  // Switching the project and running Check project both go through the main process (and `java -version`): wait for the result, not for a guess of how long it takes
  const useProject = async (dir) => { await page.selectOption('#recent-dirs', dir); await page.waitForFunction(async (d) => String((await window.crucibleHost.getRobotDir()).dir ?? '').replace(/\\/g, '/') === d.replace(/\\/g, '/'), dir, { timeout: 20000 }) }
  const runCheck = async () => { const before = await page.textContent('#checks-sum'); await page.click('#check-project'); await page.waitForFunction((b) => { const t = document.getElementById('checks-sum').textContent; return t !== b && t.length > 0 && document.querySelectorAll('#checks li').length > 0 }, before, { timeout: 30000 }) }
  const waitRunning = () => page.waitForFunction(() => /^Running/.test(document.getElementById('run-phase').textContent), null, { timeout: 15000 })
  const stopRobot = async () => { if ((await T('#launch-robot')) === 'Stop robot') { await page.click('#launch-robot'); await page.waitForFunction(() => document.getElementById('launch-robot').textContent === 'Launch robot', null, { timeout: 10000 }); await sleep(300) } }
  const userCfg = () => { try { return JSON.parse(fs.readFileSync(userData + '/crucible.config.json', 'utf8')) } catch { return {} } }

  await check('P1 the project row shows the resolved folder (set look), and the recent list stays hidden with nothing to choose from', async () => {
    await page.waitForFunction(() => document.getElementById('robot-dir').textContent.includes('proj-plain'), null, { timeout: 5000 })
    expect(await page.$eval('#robot-dir', (e) => e.classList.contains('set')), 'looks set'); expect(await page.$eval('#recent-dirs', (e) => e.hidden))
    eq(await page.getAttribute('#robot-dir', 'title'), plain)
  })
  await check('P2 Choose… with a project folder: shown, written to the settings folder, wins over the app folder file; a folder without gradlew is refused with the reason', async () => {
    await pickStub({ canceled: false, filePaths: [patched] }); await page.click('#pick-dir'); await sleep(500)
    expect((await T('#robot-dir')).includes('proj-patched'), await T('#robot-dir')); eq(userCfg().robotDir, patched); expect((await T('#notice')).includes('Robot project:'), await T('#notice'))
    const empty = SP + '/empty-folder'; fs.mkdirSync(empty, { recursive: true })
    await pickStub({ canceled: false, filePaths: [empty] }); await page.click('#pick-dir'); await sleep(500)
    expect((await T('#notice')).includes('no gradlew'), await T('#notice')); expect((await T('#robot-dir')).includes('proj-patched'), 'old choice kept')
    expect((await logLines()).some((l) => l.startsWith('[project] no gradlew')), 'reason in the log')
    await pickStub({ canceled: true, filePaths: [] }); await page.click('#pick-dir'); await sleep(300); expect((await T('#robot-dir')).includes('proj-patched'), 'cancel changes nothing')
  })
  await check('P3 recent projects: the list appears once there are two, newest first, and choosing one switches the project', async () => {
    await pickStub({ canceled: false, filePaths: [plain] }); await page.click('#pick-dir'); await sleep(500)
    expect(!(await page.$eval('#recent-dirs', (e) => e.hidden)), 'visible with two')
    const opts = await page.$$eval('#recent-dirs option', (o) => o.map((x) => x.value)); eq(opts, ['', plain, patched])
    await page.selectOption('#recent-dirs', patched); await sleep(500); expect((await T('#robot-dir')).includes('proj-patched'), 'switched')
    eq(userCfg().robotDir, patched)
  })
  await check('P4 Check project: a patched project is all green, lockstep adds its layer; the plain one lists what is missing', async () => {
    await runCheck()
    let rows = await page.$$eval('#checks li', (l) => l.map((x) => [x.className, x.querySelector('.mk').textContent, x.firstElementChild.nextSibling.firstChild.textContent]))
    eq(rows.map((r) => r[0]), ['ok', 'ok', 'ok', 'ok', 'ok'], 'all ok: ' + JSON.stringify(rows)); eq(rows.map((r) => r[1]).join(''), '✓✓✓✓✓')
    eq(await T('#checks-sum'), '✓ 5 of 5 checks passed'); expect(!(await page.$eval('#checks-box', (d) => d.open)), 'collapsed to one line when everything is fine')
    await page.selectOption('#sim-mode', 'lockstep'); await runCheck()
    eq(await page.$$eval('#checks li', (l) => l.length), 6, 'lockstep row added')
    await useProject(plain); await runCheck()
    rows = await page.$$eval('#checks li', (l) => l.map((x) => [x.className, x.querySelector('.dt').textContent]))
    expect(await page.$eval('#checks-box', (d) => d.open), 'open when something needs attention'); expect(/to look at/.test(await T('#checks-sum')) && (await page.$eval('#checks-sum', (e) => e.className)) === 'fail', await T('#checks-sum'))
    expect(rows.some((r) => r[0] === 'fail' && /SimBridge\.java/.test(r[1])), 'missing library named: ' + JSON.stringify(rows)); expect(rows.some((r) => r[0] === 'fail' && /EmuTalon|lockstep/i.test(r[1])), 'lockstep layer named')
    await page.selectOption('#sim-mode', 'robot')
  })
  await check('P5 launching an unpatched project still launches but says what is wrong in the log; a patched one logs no warnings', async () => {
    await page.click('#log-clear'); await page.click('#launch-robot'); await waitRunning()
    let l = await logLines(); expect(l.some((x) => x.startsWith('[check] ✗ Bridge library')), 'warns about the library: ' + l.filter((x) => x.startsWith('[')).join(' | ')); expect(l.some((x) => x.startsWith('[check] ! Bridge hook')), 'the hook is a warning when the library is missing too')
    await stopRobot(); await useProject(patched); await page.click('#log-clear'); await page.click('#launch-robot'); await waitRunning()
    l = await logLines(); eq(l.filter((x) => x.startsWith('[check]')), [], 'a patched project logs no check warnings')
  })
  await check('P6 extra environment: passed to the robot, the app\'s own variables win, bad lines are reported, and it survives a reload', async () => {
    await stopRobot(); await page.click('#log-clear')
    await page.click('.envbox summary'); await page.fill('#robot-env', 'FOO=bar\nthis is not valid\nCRUCIBLE_BRIDGE=0\n# comment')
    await page.click('#launch-robot'); await waitRunning(); const l = await logLines()
    expect(l.includes('FOO=bar'), 'FOO reached the robot: ' + l.filter((x) => x.startsWith('FOO') || x.startsWith('CRUCIBLE')).join('|')); expect(l.some((x) => x.includes('CRUCIBLE_BRIDGE=1')), 'the bridge variable still wins')
    expect(l.some((x) => x.startsWith('[env] line 2')), 'bad line reported: ' + l.filter((x) => x.startsWith('[env')).join('|'))
    await stopRobot(); await page.reload(); await page.waitForSelector('#start-sim'); await page.click('[data-tab=robot]')
    eq(await page.inputValue('#robot-env'), 'FOO=bar\nthis is not valid\nCRUCIBLE_BRIDGE=0\n# comment')
  })
  await check('P7 log tabs split build output from robot output; sys lines are in all of them; the count says so', async () => {
    await page.click('#log-clear'); setMode('build'); await page.click('#launch-robot'); await waitRunning(); await sleep(700)
    const total = (await logLines()).length
    await page.click('#log-src [data-src=build]'); await sleep(250); let l = await logLines()
    expect(l.some((x) => x === '> Task :compileJava') && !l.includes('robot says hello') && l.some((x) => x.startsWith('[launching')), 'Build: tasks, no robot print, app lines kept'); expect(/of \d+ lines/.test(await T('#log-count')), await T('#log-count'))
    await page.click('#log-src [data-src=robot]'); await sleep(250); l = await logLines()
    expect(l.includes('robot says hello') && l.includes('ERROR: robot problem') && !l.includes('> Task :compileJava') && l.some((x) => x.startsWith('[launching')), 'Robot tab: ' + l.join('|'))
    eq(await page.$eval('#log-src [data-src=robot]', (b) => b.getAttribute('aria-pressed')), 'true')
    await page.click('#log-src [data-src=all]'); await sleep(250); eq((await logLines()).length, total); eq(await T('#log-count'), `${total} lines`)
    await page.click('#log-src [data-src=robot]'); await page.fill('#log-filter', 'problem'); await sleep(250); l = await logLines(); expect(l.length >= 1 && l.filter((x) => !x.startsWith('[')).every((x) => /problem/i.test(x)), 'tab and text filter combine'); await page.fill('#log-filter', ''); await page.click('#log-src [data-src=all]')
  })
  await check('P8 rapid error jumps leave exactly one highlighted line', async () => {
    await page.click('#err-next'); await page.click('#err-next'); await page.click('#err-next'); await page.click('#err-next'); await sleep(100)
    eq(await page.$$eval('#robot-log .ln.flash', (e) => e.length), 1); await sleep(1500); eq(await page.$$eval('#robot-log .ln.flash', (e) => e.length), 0)
  })
  await check('P9 stack frames and compiler messages are links; a click opens the file at the line in the configured editor; unknown files say so', async () => {
    await stopRobot(); await page.click('#log-clear'); setMode('traces')
    fs.writeFileSync(userData + '/crucible.config.json', JSON.stringify({ ...userCfg(), editor: `${FAKE}/fakeeditor.sh {file} {line}` }))
    try { fs.unlinkSync(FAKE + '/editor-call.txt') } catch {}
    await page.click('#launch-robot'); await page.waitForFunction(() => document.querySelectorAll('#robot-log a.src-link').length >= 3, null, { timeout: 15000 })
    const links = await page.$$eval('#robot-log a.src-link', (a) => a.map((x) => [x.textContent, x.dataset.file, x.dataset.line]))
    eq(links, [['src/main/java/frc/robot/Shooter.java:17', 'Shooter.java', '17'], ['Robot.java:42', 'Robot.java', '42'], ['Missing.java:7', 'Missing.java', '7']])
    const full = await page.$$eval('#robot-log .ln', (e) => e.map((x) => x.textContent)); expect(full.includes('\tat frc.robot.Robot.robotInit(Robot.java:42)'), 'the line text is unchanged around the link')
    await page.click('#robot-log a.src-link[data-file="Robot.java"]'); await sleep(900)
    expect((await T('#notice')).startsWith('opened Robot.java:42'), await T('#notice'))
    const call = fs.readFileSync(FAKE + '/editor-call.txt', 'utf8').trim(); expect(call.includes('src/main/java/frc/robot') && call.includes('Robot.java') && call.endsWith('42'), 'editor got file and line: ' + call)
    await page.click('#robot-log a.src-link[data-file="Missing.java"]'); await sleep(600); expect((await T('#notice')).includes('Missing.java is not under'), await T('#notice'))
    await page.click('#robot-log a.src-link[data-file="Shooter.java"]'); await sleep(900); expect(fs.readFileSync(FAKE + '/editor-call.txt', 'utf8').includes('Shooter.java'), 'the compiler message link opens Shooter.java')
    eq(await page.$eval('#robot-log a.src-link', (a) => a.getAttribute('title')), 'Open Shooter.java at line 17')
  })
  await check('P10 an editor that cannot be started falls back to the default app instead of failing silently', async () => {
    fs.writeFileSync(userData + '/crucible.config.json', JSON.stringify({ ...userCfg(), editor: '/nonexistent/editor {file}' }))
    // the default app is stubbed: on a CI runner the real one is xdg-open, which starts whatever is registered for .java (vim, in a terminal) and never returns
    await app.evaluate(({ shell }) => { globalThis.__openedPath = null; shell.openPath = async (p) => { globalThis.__openedPath = p; return '' } })
    await page.click('#robot-log a.src-link[data-file="Robot.java"]'); await sleep(2500)
    const n = await T('#notice'); expect(/opened Robot\.java:42 \(default app\)|could not open/.test(n), n)
    const opened = await app.evaluate(() => globalThis.__openedPath); expect(typeof opened === 'string' && opened.endsWith('Robot.java'), 'the fallback asked the system to open the file: ' + opened)
  })
  await check('P11 past runs: each run is saved to a file, listed newest first, and can be put into the log split into build and robot output', async () => {
    await stopRobot(); await sleep(300)
    const files = fs.readdirSync(userData + '/logs').filter((f) => f.endsWith('.log')); expect(files.length >= 4, 'files ' + files.length)
    const txt = fs.readFileSync(userData + '/logs/' + files.sort().pop(), 'utf8'); expect(txt.startsWith('# ') && txt.includes('> Task :compileJava') && /# exited with code/.test(txt), 'file content: ' + txt.slice(0, 120))
    expect(!(await page.$eval('#history-row', (e) => e.hidden)), 'row shown'); const opts = await page.$$eval('#log-history option', (o) => o.map((x) => x.textContent))
    expect(opts.length > 4 && opts[0] === 'Past runs…' && /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d · [\d.]+ KB/.test(opts[1]), JSON.stringify(opts.slice(0, 3)))
    await page.click('#log-clear'); const first = await page.$eval('#log-history option:nth-child(2)', (o) => o.value)
    await page.selectOption('#log-history', first); await sleep(500)
    const l = await logLines(); expect(l[0].startsWith('[— past run robot-'), l[0]); expect(l.some((x) => x.startsWith('# ')), 'meta lines'); expect(l.includes('> Task :compileJava') || l.some((x) => x.includes('Exception')), 'content')
    eq(await page.inputValue('#log-history'), '', 'the list resets so the same run can be picked again'); expect(l[l.length - 1].startsWith('[— end of past run'), l[l.length - 1])
    await page.click('#log-src [data-src=robot]'); await sleep(250); const r = await logLines(); expect(r.some((x) => x.includes('Exception in thread main')) && !r.includes('> Task :compileJava'), 'history split by source'); await page.click('#log-src [data-src=all]')
  })
  await check('P13 layout: the log keeps a usable height next to the project controls (the tab scrolls), the path is shortened with the full path as tooltip', async () => {
    await page.click('[data-tab=robot]'); await page.click('#check-project'); await sleep(700)
    const h = await page.$eval('#robot-log', (e) => Math.round(e.getBoundingClientRect().height)); expect(h >= 150, 'log height ' + h)
    const t = await T('#robot-dir'); expect(t.endsWith('proj-patched') && t.length <= patched.length && (patched.split('/').filter(Boolean).length <= 3 || t.startsWith('…/')), 'short path: ' + t)
    eq(await page.getAttribute('#robot-dir', 'title'), patched)
    const sc = await page.$eval('#tab-robot', (e) => ({ sh: e.scrollHeight, ch: e.clientHeight })); expect(sc.sh >= sc.ch, 'the tab can scroll when it is too tall: ' + JSON.stringify(sc))
    await page.screenshot({ path: SP + '/e2e/out/robot-tab2.png' })
  })
  await check('P12 launching with no Java on the PATH is refused with a clear reason', async () => {
    await app.close().catch(() => {})
    const nojava = await launch({ PATH: '/nonexistent' })
    const p = nojava.page; await p.click('[data-tab=robot]'); await p.selectOption('#sim-mode', 'robot'); await p.click('#launch-robot'); await sleep(2500)
    const n = await p.textContent('#notice'); expect(/java was not found/.test(n), n); eq(await p.textContent('#launch-robot'), 'Launch robot'); eq(await p.textContent('#run-phase'), 'Could not start')
    const lines = await p.$$eval('#robot-log .ln', (els) => els.map((e) => e.textContent)); expect(lines.some((x) => x.startsWith('[check] ✗')) || lines.some((x) => x.includes('java was not found')), lines.join('|'))
    await nojava.app.close().catch(() => {})
  })
  await check('Z1 no unexpected page errors', async () => { expect(errors.length === 0, errors.join(' | ')) })
  try { fs.unlinkSync(CFG) } catch {}
  sh('pkill -f "[g]radlew simulateJava"')
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error('HARNESS ERR', e); try { fs.unlinkSync(CFG) } catch {} process.exit(1) })
