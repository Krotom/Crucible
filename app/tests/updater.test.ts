import { generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cannotSelfUpdate, cleanStale, downloadTo, extractArchive, fetchAndVerify, installTarget, parseChecksums, pickAsset, prepareSwap, sha256File, swapScript, verifySignature } from '../src/main/updater'
import { releasesUrl } from '../src/main/update'
import { interpretRelease, isAllowedUrl, type ReleaseAsset } from '../src/renderer/src/lib/versions'
import { createHash } from 'node:crypto'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crucible-upd-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const asset = (name: string, size = 10): ReleaseAsset => ({ name, url: `https://github.com/x/y/releases/download/v2/${name}`, size })

describe('choosing the file for this computer', () => {
  const all = ['BALTA-Crucible-Setup-2.0.0.exe', 'BALTA-Crucible-2.0.0-linux-x64.tar.gz', 'BALTA-Crucible-2.0.0-mac-arm64.zip', 'BALTA-Crucible-2.0.0-mac-x64.zip', 'SHA256SUMS.txt'].map((n) => asset(n))
  it('picks by platform and architecture, and never a file of another version', () => {
    expect(pickAsset(all, 'win32', 'x64', '2.0.0')?.name).toBe('BALTA-Crucible-Setup-2.0.0.exe'); expect(pickAsset(all, 'linux', 'x64', '2.0.0')?.name).toContain('linux-x64')
    expect(pickAsset(all, 'darwin', 'arm64', '2.0.0')?.name).toContain('mac-arm64'); expect(pickAsset(all, 'darwin', 'x64', '2.0.0')?.name).toContain('mac-x64')
    expect(pickAsset(all, 'linux', 'arm64', '2.0.0')).toBeNull(); expect(pickAsset(all, 'win32', 'x64', '3.0.0')).toBeNull(); expect(pickAsset(all, 'freebsd', 'x64', '2.0.0')).toBeNull()
  })
  it('reads the checksum file, ignoring junk lines and accepting the binary-mode star', () => {
    const m = parseChecksums(`${'a'.repeat(64)}  one.zip\n${'B'.repeat(64)} *two.zip\nnot a line\n${'c'.repeat(63)}  short.zip\n\n`)
    expect([...m.keys()]).toEqual(['one.zip', 'two.zip']); expect(m.get('two.zip')).toBe('b'.repeat(64))
  })
  it('only takes https addresses (and plain http on this computer) from a release answer', () => {
    expect(isAllowedUrl('https://x.test/a')).toBe(true); expect(isAllowedUrl('http://127.0.0.1:5/a')).toBe(true); expect(isAllowedUrl('http://localhost/a')).toBe(true)
    for (const bad of ['http://evil.example/a', 'ftp://x/a', 'file:///etc/passwd', 'javascript:1', 'nope']) expect(isAllowedUrl(bad), bad).toBe(false)
    const r = interpretRelease('1.0.0', 200, { tag_name: 'v2.0.0', assets: [{ name: 'ok.zip', browser_download_url: 'https://x.test/ok.zip', size: 5 }, { name: '../evil', browser_download_url: 'https://x.test/e', size: 1 }, { name: 'http.zip', browser_download_url: 'http://evil.example/h', size: 1 }, { name: 'nosize.zip', browser_download_url: 'https://x.test/n' }] })
    expect(r.assets).toEqual([{ name: 'ok.zip', url: 'https://x.test/ok.zip', size: 5 }])
  })
  it('lets only a local server stand in for the release address', () => {
    expect(releasesUrl({ CRUCIBLE_UPDATE_URL: 'http://127.0.0.1:9/r' })).toBe('http://127.0.0.1:9/r'); expect(releasesUrl({ CRUCIBLE_UPDATE_URL: 'http://evil.example/r' })).toMatch(/api\.github\.com/); expect(releasesUrl({})).toMatch(/api\.github\.com/)
  })
})

describe('signatures', () => {
  const kp = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), data = Buffer.from('sums')
  const sig = (k = kp.privateKey, d = data): string => sign(null, d, k).toString('base64')
  it('accepts the right signature and refuses a wrong key, changed data, junk and an empty key', () => {
    expect(verifySignature(data, sig(), pub)).toBe(true); expect(verifySignature(data, sig(other.privateKey), pub)).toBe(false); expect(verifySignature(Buffer.from('changed'), sig(), pub)).toBe(false)
    expect(verifySignature(data, 'not base64 !!', pub)).toBe(false); expect(verifySignature(data, sig(), '')).toBe(false); expect(verifySignature(data, '', pub)).toBe(false)
  })
})

/** a tiny release server: /f/<name> serves the given files */
function serve(files: Record<string, Buffer | string>): Promise<{ base: string; close: () => void }> {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => { const f = files[(req.url ?? '').replace('/f/', '')]; if (f === undefined) { res.statusCode = 404; res.end(); return } res.setHeader('content-length', Buffer.byteLength(f)); res.end(f) })
    s.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${(s.address() as { port: number }).port}/f/`, close: () => { s.close(); s.closeAllConnections() } }))
  })
}
const mk = (base: string, names: string[]): ReleaseAsset[] => names.map((n) => ({ name: n, url: base + n, size: 100 }))

describe('downloading and checking an update', () => {
  const payload = Buffer.from('the new app, as an archive'), name = 'BALTA-Crucible-2.0.0-linux-x64.tar.gz'
  const sums = (p: Buffer = payload): string => `${sha(p)}  ${name}\n`
  const kp = generateKeyPairSync('ed25519'), pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const go = async (files: Record<string, Buffer | string>, publicKey = '', names = Object.keys(files)) => {
    const s = await serve(files)
    try { return await fetchAndVerify({ fetchFn: fetch, assets: mk(s.base, names), platform: 'linux', arch: 'x64', version: '2.0.0', dir: join(dir, 'dl'), publicKey }) } finally { s.close() }
  }
  it('downloads, checks the checksum and returns the file', async () => {
    const v = await go({ [name]: payload, 'SHA256SUMS.txt': sums() }); expect(readFileSync(v.file)).toEqual(payload); expect(await sha256File(v.file)).toBe(sha(payload))
  })
  it('refuses a download that does not match its checksum, and deletes it', async () => {
    await expect(go({ [name]: Buffer.from('tampered'), 'SHA256SUMS.txt': sums() })).rejects.toThrow(/checksum/); expect(existsSync(join(dir, 'dl', name))).toBe(false)
  })
  it('refuses a release without checksums, one that does not list the file, and one with no file for this computer', async () => {
    await expect(go({ [name]: payload })).rejects.toThrow(/SHA256SUMS/); await expect(go({ [name]: payload, 'SHA256SUMS.txt': `${sha('x')}  other.zip\n` })).rejects.toThrow(/does not list/)
    await expect(go({ 'SHA256SUMS.txt': sums() })).rejects.toThrow(/no file for linux/)
  })
  it('with a public key built in, needs a valid signature: missing, wrong and right', async () => {
    const files = { [name]: payload, 'SHA256SUMS.txt': sums() }
    await expect(go(files, pub)).rejects.toThrow(/no SHA256SUMS\.txt\.sig/)
    const bad = sign(null, Buffer.from(sums()), generateKeyPairSync('ed25519').privateKey).toString('base64'); await expect(go({ ...files, 'SHA256SUMS.txt.sig': bad }, pub)).rejects.toThrow(/signature/)
    const tamperedSums = `${sha('evil')}  ${name}\n`; await expect(go({ [name]: Buffer.from('evil'), 'SHA256SUMS.txt': tamperedSums, 'SHA256SUMS.txt.sig': sign(null, Buffer.from(sums()), kp.privateKey).toString('base64') }, pub)).rejects.toThrow(/signature/) // a signature of other sums does not cover these
    const good = sign(null, Buffer.from(sums()), kp.privateKey).toString('base64'); expect((await go({ ...files, 'SHA256SUMS.txt.sig': good }, pub)).file).toContain(name)
  })
  it('stops a download that is too big or from a forbidden address, and reports a failing server', async () => {
    const s = await serve({ big: Buffer.alloc(5000), small: 'x' })
    try {
      await expect(downloadTo(fetch, s.base + 'big', join(dir, 'b'), 1000)).rejects.toThrow(/larger/); expect(existsSync(join(dir, 'b'))).toBe(false)
      await expect(downloadTo(fetch, s.base + 'nothere', join(dir, 'n'), 1000)).rejects.toThrow(/404/); await expect(downloadTo(fetch, 'http://evil.example/x', join(dir, 'e'), 1000)).rejects.toThrow(/refusing/)
      let seen = 0; await downloadTo(fetch, s.base + 'small', join(dir, 's'), 1000, (d) => { seen = d }); expect(seen).toBe(1)
    } finally { s.close() }
  })
})

describe('where an update goes', () => {
  it('finds the folder of a Linux copy and the bundle of a Mac copy, and nothing else', () => {
    const app = join(dir, 'BALTA-Crucible-1.1.0-linux-x64'); mkdirSync(app); writeFileSync(join(app, 'balta-crucible'), ''); writeFileSync(join(app, 'BALTA-Crucible'), '')
    expect(installTarget('linux', join(app, 'balta-crucible'))).toEqual({ kind: 'folder', path: app, parent: dir, launch: join(app, 'BALTA-Crucible') })
    expect(installTarget('linux', join(dir, 'electron'))).toBeNull(); expect(installTarget('darwin', '/Applications/BALTA Crucible.app/Contents/MacOS/BALTA Crucible')).toEqual({ kind: 'bundle', path: '/Applications/BALTA Crucible.app', parent: '/Applications', launch: '/Applications/BALTA Crucible.app' })
    expect(installTarget('darwin', '/usr/bin/electron')).toBeNull(); expect(installTarget('win32', 'C:\\Program Files\\BALTA Crucible\\BALTA Crucible.exe')?.kind).toBe('installer'); expect(installTarget('freebsd', '/x')).toBeNull()
  })
  it('says why a copy cannot update itself: a development run, an unknown layout, a folder it cannot write', async () => {
    expect(await cannotSelfUpdate({ packaged: false, platform: 'linux', execPath: '/x' })).toMatch(/development/); expect(await cannotSelfUpdate({ packaged: true, platform: 'linux', execPath: join(dir, 'electron') })).toMatch(/layout/)
    const app = join(dir, 'app'); mkdirSync(app); writeFileSync(join(app, 'balta-crucible'), ''); writeFileSync(join(app, 'BALTA-Crucible'), '')
    expect(await cannotSelfUpdate({ packaged: true, platform: 'linux', execPath: join(app, 'balta-crucible') })).toBeNull()
    if (process.getuid && process.getuid() !== 0) { chmodSync(dir, 0o555); expect(await cannotSelfUpdate({ packaged: true, platform: 'linux', execPath: join(app, 'balta-crucible') })).toMatch(/not writable/); chmodSync(dir, 0o755) }
  })
})

// the swap script is a shell script for Linux and macOS (Windows updates through its installer), and tar unpacks the Linux archive: nothing to run for real on Windows
const posixOnly = process.platform === 'win32'
describe.skipIf(posixOnly)('the swap script (run for real in a temporary folder)', () => {
  const sh = (script: string, args: string[]) => spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', timeout: 30000 })
  const setup = (): { script: string; cur: string; fresh: string; old: string; launch: string } => {
    const cur = join(dir, 'app'), fresh = join(dir, 'stage', 'app'), old = join(dir, 'app.old'), script = join(dir, 'swap.sh')
    mkdirSync(cur); writeFileSync(join(cur, 'version'), 'old'); mkdirSync(fresh, { recursive: true }); writeFileSync(join(fresh, 'version'), 'new')
    writeFileSync(script, swapScript('folder'), { mode: 0o755 })
    const launch = join(dir, 'launch.sh'); writeFileSync(launch, `#!/bin/sh\ncat "${cur}/version" > "${dir}/started-with"\n`, { mode: 0o755 })
    return { script, cur, fresh, old, launch }
  }
  it('replaces the folder after the app has exited, removes the old copy, and starts the new one', () => {
    const s = setup(); const r = sh(s.script, ['99999999', s.cur, s.fresh, s.old, s.launch]) // a pid that does not exist: the app is already gone
    expect(r.status).toBe(0); expect(readFileSync(join(s.cur, 'version'), 'utf8')).toBe('new'); expect(existsSync(s.old)).toBe(false); expect(existsSync(s.fresh)).toBe(false); expect(existsSync(join(dir, 'stage'))).toBe(false) /* the work folder is gone too */; expect(readFileSync(join(dir, 'started-with'), 'utf8')).toBe('new')
  })
  it('replaces an old copy left by an earlier attempt', () => {
    const s = setup(); mkdirSync(s.old); writeFileSync(join(s.old, 'junk'), 'x'); expect(sh(s.script, ['99999999', s.cur, s.fresh, s.old, s.launch]).status).toBe(0); expect(existsSync(s.old)).toBe(false); expect(readFileSync(join(s.cur, 'version'), 'utf8')).toBe('new')
  })
  it('puts the old version back and starts it when the swap cannot be done', () => {
    const s = setup(); rmSync(s.fresh, { recursive: true }) // the new copy vanished: the second mv fails
    expect(sh(s.script, ['99999999', s.cur, s.fresh, s.old, s.launch]).status).toBe(0); expect(readFileSync(join(s.cur, 'version'), 'utf8')).toBe('old'); expect(existsSync(s.old)).toBe(false); expect(readFileSync(join(dir, 'started-with'), 'utf8')).toBe('old')
  })
  it('leaves everything alone while the app is still running', () => {
    const s = setup(); const live = spawn('sleep', ['60'], { stdio: 'ignore' }); const pid = String(live.pid)
    try {
      const t0 = Date.now(); const r = spawnSync('/bin/sh', ['-c', `sed -i 's/-lt 300/-lt 3/' "${s.script}"; /bin/sh "${s.script}" ${pid} "${s.cur}" "${s.fresh}" "${s.old}" "${s.launch}"`], { encoding: 'utf8', timeout: 30000 })
      expect(r.status).toBe(1); expect(readFileSync(join(s.cur, 'version'), 'utf8')).toBe('old'); expect(existsSync(s.fresh)).toBe(true); expect(Date.now() - t0).toBeLessThan(10000)
    } finally { live.kill() }
  })
})

describe.skipIf(posixOnly)('unpacking and cleaning up', () => {
  it('unpacks a Linux archive to its app folder, and refuses an archive without the app', () => {
    const src = join(dir, 'src', 'BALTA-Crucible-2.0.0-linux-x64'); mkdirSync(src, { recursive: true }); writeFileSync(join(src, 'balta-crucible'), 'bin'); writeFileSync(join(src, 'BALTA-Crucible'), 'sh')
    const tgz = join(dir, 'a.tar.gz'); expect(spawnSync('tar', ['-czf', tgz, '-C', join(dir, 'src'), 'BALTA-Crucible-2.0.0-linux-x64']).status).toBe(0)
    expect(extractArchive('folder', tgz, join(dir, 'w1'))).toBe(join(dir, 'w1', 'BALTA-Crucible-2.0.0-linux-x64'))
    const empty = join(dir, 'empty', 'x'); mkdirSync(empty, { recursive: true }); const tgz2 = join(dir, 'b.tar.gz'); spawnSync('tar', ['-czf', tgz2, '-C', join(dir, 'empty'), 'x']); expect(() => extractArchive('folder', tgz2, join(dir, 'w2'))).toThrow(/does not contain the app/)
    writeFileSync(join(dir, 'junk.tar.gz'), 'not an archive'); expect(() => extractArchive('folder', join(dir, 'junk.tar.gz'), join(dir, 'w3'))).toThrow(/could not unpack/)
  })
  it('prepares a swap without changing anything, and removes only stale leftovers', async () => {
    const app = join(dir, 'BALTA-Crucible-1.1.0-linux-x64'); mkdirSync(app); writeFileSync(join(app, 'balta-crucible'), ''); writeFileSync(join(app, 'BALTA-Crucible'), 'old'); writeFileSync(join(app, 'marker'), 'old')
    const src = join(dir, 'src', 'BALTA-Crucible-2.0.0-linux-x64'); mkdirSync(src, { recursive: true }); writeFileSync(join(src, 'balta-crucible'), 'bin'); writeFileSync(join(src, 'BALTA-Crucible'), 'sh')
    const tgz = join(dir, 'new.tar.gz'); spawnSync('tar', ['-czf', tgz, '-C', join(dir, 'src'), 'BALTA-Crucible-2.0.0-linux-x64'])
    const target = installTarget('linux', join(app, 'balta-crucible'))!
    const plan = await prepareSwap({ platform: 'linux', target, verified: { file: tgz }, pid: 4242, tmpDir: join(dir, 'tmp') })
    expect(readFileSync(join(app, 'marker'), 'utf8')).toBe('old'); expect(plan.command).toBe('/bin/sh'); expect(plan.commandArgs.slice(1, 3)).toEqual(['4242', app]); expect(existsSync(plan.args[2])).toBe(true)
    // leftovers: a fresh one is kept (an update may be running), an old one goes
    const staleDir = readdirSync(dir).find((e) => e.startsWith('.crucible-update-'))!; await cleanStale(target); expect(existsSync(join(dir, staleDir))).toBe(true)
    const t = Date.now() / 1000 - 3600; utimesSync(join(dir, staleDir), t, t); await cleanStale(target); expect(existsSync(join(dir, staleDir))).toBe(false); expect(existsSync(app)).toBe(true)
  })
})

describe('signing scripts (run for real in a temporary tree)', () => {
  it('make a key pair, put the public half into the app source, and sign what the app then verifies', () => {
    const root = join(dir, 'tree'); mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'src', 'main'), { recursive: true })
    for (const f of ['update-keys.mjs', 'sign-release.mjs']) writeFileSync(join(root, 'scripts', f), readFileSync(new URL(`../scripts/${f}`, import.meta.url)))
    writeFileSync(join(root, 'src', 'main', 'update-key.ts'), readFileSync(new URL('../src/main/update-key.ts', import.meta.url)))
    const keys = spawnSync(process.execPath, [join(root, 'scripts', 'update-keys.mjs')], { cwd: root, encoding: 'utf8' }); expect(keys.status, keys.stderr).toBe(0)
    const src = readFileSync(join(root, 'src', 'main', 'update-key.ts'), 'utf8'); const pub = /`(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----)`/.exec(src)![1]
    expect(src).not.toContain('PRIVATE'); const priv = readFileSync(join(root, 'update-private-key.pem'), 'utf8'); expect(priv).toContain('PRIVATE KEY')
    const sums = join(root, 'SHA256SUMS.txt'); writeFileSync(sums, `${'a'.repeat(64)}  x.zip\n`)
    const signed = spawnSync(process.execPath, [join(root, 'scripts', 'sign-release.mjs'), sums], { cwd: root, env: { ...process.env, UPDATE_SIGNING_KEY: priv }, encoding: 'utf8' }); expect(signed.status, signed.stderr).toBe(0)
    expect(verifySignature(readFileSync(sums), readFileSync(`${sums}.sig`, 'utf8'), pub)).toBe(true)
    writeFileSync(sums, `${'b'.repeat(64)}  x.zip\n`); expect(verifySignature(readFileSync(sums), readFileSync(`${sums}.sig`, 'utf8'), pub)).toBe(false) // changed after signing
    const again = spawnSync(process.execPath, [join(root, 'scripts', 'update-keys.mjs')], { cwd: root, encoding: 'utf8' }); expect(again.status).toBe(1); expect(again.stderr).toContain('exists already') // never silently replaces the key
    expect(spawnSync(process.execPath, [join(root, 'scripts', 'sign-release.mjs'), sums], { cwd: root, env: { ...process.env, UPDATE_SIGNING_KEY: '' }, encoding: 'utf8' }).status).toBe(2)
  })
})
