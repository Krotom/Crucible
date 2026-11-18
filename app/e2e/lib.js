// tiny test harness for the UI checks: every check records pass / fail / note, a failure takes a screenshot
const fs = require('fs')
const path = require('path')
const results = []
let page = null
const SP = process.env.SP
exports.setPage = (p) => { page = p }
exports.results = results
exports.check = async (name, fn) => {
  const t0 = Date.now()
  try {
    const r = await fn()
    // fn may return a string note for "works, but..." findings
    results.push({ name, status: typeof r === 'string' ? 'NOTE' : 'PASS', note: typeof r === 'string' ? r : '', ms: Date.now() - t0 })
  } catch (e) {
    let shot = ''
    try { if (page) { shot = path.join(SP, 'e2e', 'fail-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 50) + '.png'); await page.screenshot({ path: shot }) } } catch {}
    results.push({ name, status: 'FAIL', note: String(e && e.message || e).split('\n')[0].slice(0, 300), shot, ms: Date.now() - t0 })
  }
  const r = results[results.length - 1]
  console.log(`${r.status.padEnd(4)} ${r.name}${r.note ? '  -- ' + r.note : ''}`)
}
exports.expect = (cond, msg) => { if (!cond) throw new Error(msg || 'expectation failed') }
exports.eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }
// E2E_SLOW multiplies every fixed wait: a CI runner has fewer CPUs than a desk machine and the page (software WebGL) answers later
// Only short waits are stretched: a long sleep is usually a duration ("play for 3 s") that a test's numbers depend on.
exports.slow = Number(process.env.E2E_SLOW) || 1
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms <= 800 ? ms * exports.slow : ms))
exports.summary = () => {
  const c = { PASS: 0, NOTE: 0, FAIL: 0 }
  for (const r of results) c[r.status]++
  console.log(`\nSUMMARY: ${c.PASS} pass, ${c.NOTE} note, ${c.FAIL} fail`)
  fs.writeFileSync(path.join(SP, 'e2e', 'last-results.json'), JSON.stringify(results, null, 2))
  return c.FAIL
}

const { _electron } = require('playwright')
const { execSync } = require('child_process')
exports.APP = require('path').resolve(__dirname, '..')
exports.launch = async (extraEnv = {}, opts = {}) => {
  // every launch gets its own settings folder, so nothing leaks from one suite (or run) into the next (a test that restarts the app passes the folder to reuse)
  const userData = opts.userData || require('fs').mkdtempSync(require('path').join(process.env.SP || require('os').tmpdir(), 'userdata-'))
  const app = await _electron.launch({
    executablePath: exports.APP + '/node_modules/electron/dist/electron',
    args: ['--no-sandbox', '--user-data-dir=' + userData, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--in-process-gpu', exports.APP],
    cwd: exports.APP,
    env: { ...process.env, ...extraEnv },
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()) })
  await page.waitForSelector('#start-sim', { timeout: 30000 })
  await page.waitForFunction(() => !!window.crucible, null, { timeout: 60000 }) // the page's script sets this last; a slow runner shows the controls long before
  exports.setPage(page)
  return { app, page, errors, userData }
}
exports.sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim() } catch (e) { return '' } }
