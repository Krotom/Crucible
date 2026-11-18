// Starts a packaged app and checks that it comes up: node scripts/smoke-packaged.mjs <executable> <expected version>
// It drives the real window (Playwright), waits for the interface, reads the version from the footer and the About box, starts a sim and checks that it runs.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [exe, version] = process.argv.slice(2)
if (!exe || !version) { console.error('usage: node scripts/smoke-packaged.mjs <executable> <version>'); process.exit(2) }
const { _electron } = createRequire(import.meta.url)('playwright')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-smoke-'))
const fail = (m) => { console.error(`SMOKE FAIL: ${m}`); process.exitCode = 1 }
let app
try {
  app = await _electron.launch({ executablePath: exe, args: ['--no-sandbox', `--user-data-dir=${userData}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--in-process-gpu'], timeout: 60000 })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('#start-sim', { timeout: 60000 })
  const title = await page.title()
  if (title !== 'BALTA Crucible') fail(`window title is "${title}"`)
  const footer = await page.textContent('.legal')
  if (!footer.includes(`v${version}`)) fail(`the footer says "${footer.trim()}", expected v${version}`)
  const mainVersion = await app.evaluate(({ app }) => app.getVersion())
  if (mainVersion !== version) fail(`app.getVersion() is ${mainVersion}`)
  const name = await app.evaluate(({ app }) => app.getName())
  if (name !== 'BALTA Crucible') fail(`app name is "${name}"`)
  await page.click('#start-sim')
  await page.waitForFunction(() => !!window.crucible?.sim?.latest, null, { timeout: 60000 })
  await page.click('#play') // a new sim waits for Play
  await page.waitForFunction(() => window.crucible.sim.latest.time > 0.5, null, { timeout: 60000 })
  const host = await page.evaluate(() => typeof window.crucibleHost?.checkUpdate === 'function')
  if (!host) fail('the host bridge (preload) is missing')
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`)
  if (!process.exitCode) console.log(`SMOKE OK: ${name} ${mainVersion}, title "${title}", sim running`)
} catch (e) { fail(String(e?.message ?? e)) }
finally { try { await app?.close() } catch { /* already gone */ } }
