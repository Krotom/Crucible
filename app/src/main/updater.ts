// Self-update. The app asks the GitHub releases of its repository for the newest version, downloads the file for this platform, checks it, and swaps itself:
//   Windows: runs the NSIS installer with only its progress window (/UPDATE; it upgrades in place), after the app has quit, and starts the new app afterwards
//   Linux:   replaces the unpacked folder with the new one
//   macOS:   replaces BALTA Crucible.app with the new one
// The swap is done by a small script that waits for this process to exit, so the files are never replaced under a running app, and that puts the old
// version back (and starts it) if the swap fails. Every download is checked against SHA256SUMS.txt from the same release; when the app carries a public
// key (src/main/update-key.ts) SHA256SUMS.txt must also carry a valid Ed25519 signature, which a copied or tampered release cannot have.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isAllowedUrl, type ReleaseAsset } from '../renderer/src/lib/versions'

export const SUMS_NAME = 'SHA256SUMS.txt'
export const SIG_NAME = 'SHA256SUMS.txt.sig'
export const MAX_DOWNLOAD = 700 * 1024 * 1024

export type Platform = 'win32' | 'linux' | 'darwin'

/** The release file that holds this platform's build, or null. */
export function pickAsset(assets: ReleaseAsset[], platform: string, arch: string, version: string): ReleaseAsset | null {
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  const name = platform === 'win32' ? `BALTA-Crucible-Setup-${version}.exe` : platform === 'linux' ? `BALTA-Crucible-${version}-linux-${a}.tar.gz` : platform === 'darwin' ? `BALTA-Crucible-${version}-mac-${a}.zip` : ''
  return assets.find((x) => x.name === name) ?? null
}

/** Reads a sha256sum file: "<64 hex>  <name>" per line. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$/.exec(line)
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((ok, fail) => fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => ok()).on('error', fail))
  return h.digest('hex')
}

/** Checks an Ed25519 signature (base64) over some bytes with a public key (PEM). False for anything wrong, never throws. */
export function verifySignature(data: Uint8Array, sigBase64: string, publicKeyPem: string): boolean {
  try { return verify(null, data, createPublicKey(publicKeyPem), Buffer.from(sigBase64.trim(), 'base64')) } catch { return false }
}

export interface Progress { stage: 'download' | 'verify' | 'prepare' | 'restart'; done?: number; total?: number; text: string }

/** Streams a file to disk, with a size cap and progress. */
export async function downloadTo(fetchFn: typeof fetch, url: string, dest: string, maxBytes: number, onBytes?: (done: number, total: number) => void): Promise<number> {
  if (!isAllowedUrl(url)) throw new Error('refusing to download from that address')
  const res = await fetchFn(url, { headers: { 'User-Agent': 'balta-crucible', Accept: 'application/octet-stream' }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (total > maxBytes) throw new Error('the file is larger than an update can be')
  await mkdir(path.dirname(dest), { recursive: true })
  const out = fs.createWriteStream(dest)
  let done = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      done += value.byteLength
      if (done > maxBytes) throw new Error('the file is larger than an update can be')
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      onBytes?.(done, total)
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
  } catch (e) { out.destroy(); await rm(dest, { force: true }); throw e }
  return done
}

export interface Verified { file: string }

/** Downloads the platform's file and SHA256SUMS.txt (and its signature when a key is configured) into `dir`, and checks them. Throws with a reason. */
export async function fetchAndVerify(opts: { fetchFn: typeof fetch; assets: ReleaseAsset[]; platform: string; arch: string; version: string; dir: string; publicKey: string; onProgress?: (p: Progress) => void }): Promise<Verified> {
  const { fetchFn, assets, dir, publicKey, onProgress } = opts
  const asset = pickAsset(assets, opts.platform, opts.arch, opts.version)
  if (!asset) throw new Error(`this release has no file for ${opts.platform} ${opts.arch}`)
  const sums = assets.find((a) => a.name === SUMS_NAME)
  if (!sums) throw new Error(`this release has no ${SUMS_NAME}: refusing to install an unchecked file`)
  const sig = assets.find((a) => a.name === SIG_NAME)
  if (publicKey && !sig) throw new Error(`this release has no ${SIG_NAME} (the app only installs signed releases)`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const sumsFile = path.join(dir, SUMS_NAME)
  await downloadTo(fetchFn, sums.url, sumsFile, 1024 * 1024)
  if (publicKey && sig) {
    const sigFile = path.join(dir, SIG_NAME)
    await downloadTo(fetchFn, sig.url, sigFile, 4096)
    if (!verifySignature(await readFile(sumsFile), await readFile(sigFile, 'utf8'), publicKey)) throw new Error('the signature of this release is not valid: not installing it')
  }
  const want = parseChecksums(await readFile(sumsFile, 'utf8')).get(asset.name)
  if (!want) throw new Error(`${SUMS_NAME} does not list ${asset.name}`)
  const file = path.join(dir, asset.name)
  onProgress?.({ stage: 'download', done: 0, total: asset.size, text: 'Downloading…' })
  await downloadTo(fetchFn, asset.url, file, MAX_DOWNLOAD, (done, total) => onProgress?.({ stage: 'download', done, total: total || asset.size, text: 'Downloading…' }))
  onProgress?.({ stage: 'verify', text: 'Checking the download…' })
  const got = await sha256File(file)
  if (got !== want) { await rm(file, { force: true }); throw new Error('the download does not match its checksum (damaged or tampered): not installing it') }
  return { file }
}

export interface InstallTarget { kind: 'folder' | 'bundle' | 'installer'; /** what gets replaced */ path: string; /** the folder that must be writable */ parent: string; /** what to start afterwards */ launch: string }

/** Where this running copy lives, and what a swap would replace. Null when it is not a packaged copy of ours. */
export function installTarget(platform: string, execPath: string): InstallTarget | null {
  if (platform === 'win32') return { kind: 'installer', path: execPath, parent: path.dirname(execPath), launch: execPath }
  if (platform === 'linux') {
    const dir = path.dirname(execPath)
    return path.basename(execPath) === 'balta-crucible' && fs.existsSync(path.join(dir, 'BALTA-Crucible')) ? { kind: 'folder', path: dir, parent: path.dirname(dir), launch: path.join(dir, 'BALTA-Crucible') } : null
  }
  if (platform === 'darwin') {
    const m = /^(.*\.app)\//.exec(execPath)
    return m ? { kind: 'bundle', path: m[1], parent: path.dirname(m[1]), launch: m[1] } : null
  }
  return null
}

export async function writable(dir: string): Promise<boolean> { try { await access(dir, fs.constants.W_OK); return true } catch { return false } }

/** Why this copy cannot update itself, or null when it can. */
export async function cannotSelfUpdate(opts: { packaged: boolean; platform: string; execPath: string }): Promise<string | null> {
  if (!opts.packaged) return 'This is a development run: update by pulling the source.'
  const t = installTarget(opts.platform, opts.execPath)
  if (!t) return 'This copy of the app is not in the layout the updater knows.'
  if (t.kind !== 'installer' && !(await writable(t.parent))) return `The folder ${t.parent} is not writable for you: download the new version and replace it by hand.`
  return null
}

/** The script that waits for the app to exit, swaps the folder or bundle (undoing it if that fails) and starts the app again. POSIX sh. */
export function swapScript(kind: 'folder' | 'bundle'): string {
  return `#!/bin/sh
# args: <pid of the app> <current> <new> <old> <what to start>
PID="$1"; CUR="$2"; NEW="$3"; OLD="$4"; LAUNCH="$5"
i=0
while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i + 1)); done
if kill -0 "$PID" 2>/dev/null; then exit 1; fi
rm -rf "$OLD"
if mv "$CUR" "$OLD" && mv "$NEW" "$CUR"; then
  rm -rf "$OLD"
else
  # put the old version back so the app still starts
  if [ ! -e "$CUR" ] && [ -e "$OLD" ]; then mv "$OLD" "$CUR"; fi
  rm -rf "$NEW"
fi
rm -rf "$(dirname "$NEW")" # the work folder this script lives in
${kind === 'bundle' ? 'exec open "$LAUNCH"' : 'exec "$LAUNCH"'}
`
}

/**
 * The Windows update script (PowerShell, which every Windows has): waits for the app to exit, runs the installer with only its progress window showing, /UPDATE (Windows asks the user for permission: the installer
 * needs administrator rights) and starts the app again, the new one when the install worked and the old one when it did not. It writes crucible-update.log next to the script,
 * because the script itself has no window (the installer shows its own progress). Every value is written into the script itself, so there is no command line to quote.
 * (It used to be a batch file. cmd.exe breaks on a command line with several quoted paths, and, started without a console as it is here, its tasklist and find leave the
 * script waiting for ever. PowerShell has neither problem.)
 */
export function winScript(appPid: number, installer: string, launch: string, logFile: string): string {
  const lit = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
  return [
    "$ErrorActionPreference = 'Continue'",
    '$log = ' + lit(logFile),
    'function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff") + " " + $m) }',
    'Log ("waiting for the app (pid " + ' + String(appPid) + ' + ") to exit")',
    '$app = Get-Process -Id ' + String(appPid) + ' -ErrorAction SilentlyContinue',
    'if ($app -and -not $app.WaitForExit(120000)) { Log "the app did not exit within 2 minutes: giving up"; exit 1 }',
    'Log ("running the installer " + ' + lit(installer) + ')',
    '$code = "none"',
    'try { $setup = Start-Process -FilePath ' + lit(installer) + " -ArgumentList '/UPDATE' -Wait -PassThru; $code = $setup.ExitCode } catch { Log (\"could not run the installer: \" + $_.Exception.Message) }",
    'Log ("the installer finished with exit code " + $code)',
    'Log ("starting the app " + ' + lit(launch) + ')',
    'try { Start-Process -FilePath ' + lit(launch) + ' } catch { Log ("could not start the app: " + $_.Exception.Message) }',
    '',
  ].join('\r\n')
}

/** The command that runs a PowerShell script text with no file and no quoting: -EncodedCommand takes the script as base64 of its UTF-16 text (and is not subject to the execution policy). */
export function powershellCommand(script: string): { command: string; args: string[] } {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return { command: exe, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}

/** Unpacks the downloaded archive next to the install target and returns the path of the new copy. */
export function extractArchive(kind: 'folder' | 'bundle', archive: string, workDir: string): string {
  fs.mkdirSync(workDir, { recursive: true })
  const r = kind === 'folder' ? spawnSync('tar', ['-xzf', archive, '-C', workDir]) : spawnSync('ditto', ['-x', '-k', archive, workDir])
  if (r.status !== 0) throw new Error(`could not unpack the update (${String(r.stderr ?? '').trim().slice(0, 200) || 'the archive is damaged'})`)
  const entries = fs.readdirSync(workDir)
  const found = kind === 'folder' ? entries.find((e) => fs.statSync(path.join(workDir, e)).isDirectory()) : entries.find((e) => e.endsWith('.app'))
  if (!found) throw new Error('the update archive does not contain the app')
  const out = path.join(workDir, found)
  if (kind === 'folder' && !fs.existsSync(path.join(out, 'balta-crucible'))) throw new Error('the update archive does not contain the app')
  return out
}

export interface SwapPlan { script: string; args: string[]; command: string; commandArgs: string[]; /** Windows: the arguments are one ready-made command line, passed as they are */ verbatim?: boolean }

/** Everything needed to start the swap after the app has quit; nothing is changed yet. */
export async function prepareSwap(opts: { platform: string; target: InstallTarget; verified: Verified; pid: number; tmpDir: string }): Promise<SwapPlan> {
  const { target, verified, pid, tmpDir } = opts
  if (target.kind === 'installer') {
    const script = path.join(tmpDir, 'crucible-update.ps1')
    const text = winScript(pid, verified.file, target.launch, path.join(tmpDir, 'crucible-update.log'))
    await writeFile(script, text) // kept next to the log, to read what ran (the plan below runs the same text)
    const ps = powershellCommand(text)
    // Why this shape. The helper has to outlive the app, and Node ties a child to its parent with a job object unless the child is "detached"; a detached child has NO console,
    // and PowerShell (like cmd's tools) does not run without one. So: a detached cmd.exe, which survives, uses start to give PowerShell a console of its own (minimised, and the
    // script hides it). The line is passed verbatim: /s makes cmd strip only the outermost pair of quotes, so the quotes round the PowerShell path stay.
    const line = 'start "" /min "' + ps.command + '" ' + ps.args.join(' ')
    return { script, args: [String(pid), verified.file, target.launch], command: 'cmd.exe', commandArgs: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true }
  }
  const work = path.join(target.parent, `.crucible-update-${process.pid}-${Date.now()}`)
  const fresh = extractArchive(target.kind, verified.file, work)
  const script = path.join(work, 'swap.sh')
  await writeFile(script, swapScript(target.kind), { mode: 0o755 })
  const old = `${target.path}.old`
  const args = [String(pid), target.path, fresh, old, target.launch]
  return { script, args, command: '/bin/sh', commandArgs: [script, ...args] }
}

/** Starts the swap script detached, so it outlives this process. */
export function startSwap(plan: SwapPlan): void {
  const child = spawn(plan.command, plan.commandArgs, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: plan.verbatim === true })
  child.unref()
}

/** Removes the leftovers of an update that was interrupted: work folders next to the app and an old copy. Best effort, never throws. */
export async function cleanStale(target: InstallTarget | null): Promise<void> {
  if (!target || target.kind === 'installer') return
  try {
    for (const e of fs.readdirSync(target.parent)) {
      if (e.startsWith('.crucible-update-') || e === `${path.basename(target.path)}.old`) {
        const p = path.join(target.parent, e)
        if (Date.now() - fs.statSync(p).mtimeMs > 60_000) await rm(p, { recursive: true, force: true })
      }
    }
  } catch { /* nothing to clean */ }
}
