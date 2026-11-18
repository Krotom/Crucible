// The self-update, end to end, with a real packaged app (Linux): node e2e/update-packaged.mjs <BALTA-Crucible-<version>-linux-x64.tar.gz>
// A release server on this computer offers version 9.0.0 (the same app with a bumped version and a marker file). The packaged app finds it, downloads it,
// checks it, swaps its own folder after quitting and starts the new copy. A second, damaged release must be refused and leave the app untouched.
// Run under xvfb with Playwright available (NODE_PATH).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tgz = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(tgz)) { console.error('usage: node e2e/update-packaged.mjs <linux x64 tar.gz>'); process.exit(2) }
const { _electron } = createRequire(import.meta.url)('playwright')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); console.log('PASS', name) } catch (e) { results.push(['FAIL', name]); console.log('FAIL', name, '--', String(e.message ?? e).split('\n')[0]) } }
const expect = (c, m) => { if (!c) throw new Error(m ?? 'expectation failed') }
const sha = (b) => createHash('sha256').update(b).digest('hex')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-update-e2e-'))
const install = path.join(root, 'install'); fs.mkdirSync(install)
expect(spawnSync('tar', ['-xzf', tgz, '-C', install]).status === 0, 'unpack the package')
const appDir = path.join(install, fs.readdirSync(install)[0])
const exe = path.join(appDir, 'balta-crucible')
const appPkg = path.join(appDir, 'resources', 'app', 'package.json')
const version = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).version

// the "new release": the same folder with another version and a marker, packed under the name a real release has
const newName = 'BALTA-Crucible-9.0.0-linux-x64'
const newSrc = path.join(root, 'newsrc'); fs.mkdirSync(newSrc)
spawnSync('cp', ['-a', appDir, path.join(newSrc, newName)])
const np = path.join(newSrc, newName, 'resources', 'app', 'package.json')
fs.writeFileSync(np, JSON.stringify({ ...JSON.parse(fs.readFileSync(np, 'utf8')), version: '9.0.0' }))
fs.writeFileSync(path.join(newSrc, newName, 'resources', 'app', 'UPDATED_MARKER'), 'yes')
const newTgz = path.join(root, `${newName}.tar.gz`)
expect(spawnSync('tar', ['-czf', newTgz, '-C', newSrc, newName]).status === 0, 'pack the new release')
const good = fs.readFileSync(newTgz)

let mode = 'bad' // first a damaged download, then the real one
let base = ''
const serverFiles = () => {
  const body = mode === 'bad' ? Buffer.concat([good.subarray(0, good.length - 100), Buffer.alloc(100, 1)]) : good // same size, different bytes
  return { [`${newName}.tar.gz`]: body, 'SHA256SUMS.txt': `${sha(good)}  ${newName}.tar.gz\n` }
}
const server = http.createServer((req, res) => {
  if (req.url === '/latest') {
    const files = serverFiles()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://github.com/example/x/releases/tag/v9.0.0', body: 'test release', assets: Object.entries(files).map(([name, b]) => ({ name, browser_download_url: base + name, size: b.length })) }))
    return
  }
  const f = serverFiles()[(req.url ?? '').replace('/f/', '')]
  if (!f) { res.statusCode = 404; res.end(); return }
  res.setHeader('content-length', f.length); res.end(f)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const port = server.address().port
base = `http://127.0.0.1:${port}/f/`

const launch = () => _electron.launch({
  executablePath: exe, timeout: 60000, env: { ...process.env, CRUCIBLE_UPDATE_URL: `http://127.0.0.1:${port}/latest` },
  args: ['--no-sandbox', `--user-data-dir=${path.join(root, 'userdata')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--in-process-gpu'],
})
const pids = () => spawnSync('pgrep', ['-f', exe], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

let app = await launch()
let page = await app.firstWindow()
await page.waitForSelector('#start-sim', { timeout: 60000 })

await check('U1 the app announces the new version with a toast at start (a test server is set, so it asks at once)', async () => {
  await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('9.0.0 is available')), null, { timeout: 20000 })
})
await check('U2 About shows the install button for a packaged copy that can write its folder', async () => {
  await page.click('#about-btn'); await page.waitForSelector('#about[open]')
  expect((await page.textContent('#update-status')).includes('9.0.0 is available'), await page.textContent('#update-status'))
  expect(!(await page.$eval('#update-actions', (e) => e.hidden)), 'install button visible')
})
await check('U3 a damaged download is refused, the message says why, and nothing on disk changes', async () => {
  await page.click('#update-install')
  await page.waitForFunction(() => document.getElementById('update-status').textContent.includes('not installed'), null, { timeout: 60000 })
  const t = await page.textContent('#update-status'); expect(t.includes('checksum'), t)
  expect(version(appPkg) === '1.1.0', 'still the old version'); expect(!fs.existsSync(path.join(appDir, 'resources', 'app', 'UPDATED_MARKER')), 'no marker')
  expect(!(await page.$eval('#update-install', (b) => b.disabled)), 'the button works again'); expect(pids().length > 0, 'the app is still running')
})
mode = 'good'
const oldPid = app.process().pid
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
await check('U4 the real release installs: the app quits, its folder is swapped, and the new copy starts', async () => {
  await page.click('#update-btn'); await page.waitForFunction(() => !document.getElementById('update-actions').hidden, null, { timeout: 20000 })
  await page.click('#update-install')
  for (let i = 0; i < 150 && alive(oldPid); i++) await sleep(200)
  expect(!alive(oldPid), 'the old app quit')
  for (let i = 0; i < 150 && !(fs.existsSync(path.join(appDir, 'resources', 'app', 'UPDATED_MARKER')) && version(appPkg) === '9.0.0'); i++) await sleep(200)
  expect(version(appPkg) === '9.0.0', 'the folder holds version ' + version(appPkg)); expect(fs.existsSync(path.join(appDir, 'resources', 'app', 'UPDATED_MARKER')), 'the new files are there')
  expect(fs.existsSync(exe), 'the executable is in place')
})
await check('U5 nothing is left behind (no .old copy, no work folder), and the new copy is running', async () => {
  let started = false
  for (let i = 0; i < 100 && !started; i++) { started = pids().length > 0; if (!started) await sleep(200) }
  expect(started, 'the new copy started')
  const left = fs.readdirSync(install); expect(left.length === 1 && left[0] === path.basename(appDir), 'leftovers: ' + left.join(', '))
  expect(!fs.existsSync(path.join(install, '.crucible-update-x')), 'no work folder')
})
for (const p of pids()) spawnSync('kill', [p])
await sleep(500)
server.close()
fs.rmSync(root, { recursive: true, force: true })
const failed = results.filter((r) => r[0] === 'FAIL').length
console.log(`\nSUMMARY: ${results.length - failed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
