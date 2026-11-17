// Builds the Windows installer: node scripts/build-installer.mjs [--skip-build]   (npm run installer)
//   1. builds the app (electron-vite), 2. stages a copy of the Electron runtime with the built app inside, renamed and branded (icon, version info),
//   3. adds the robot integration tool (it runs on the app's own runtime), 4. runs NSIS (makensis) on installer/installer.nsi.
// Output: dist-installer/BALTA-Crucible-Setup-<version>.exe. Needs NSIS (default C:\Program Files (x86)\NSIS, or the MAKENSIS environment variable).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(app, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
const version = pkg.version
const outDir = path.join(app, 'dist-installer')
const stage = path.join(outDir, 'stage')
const installer = path.join(outDir, `BALTA-Crucible-Setup-${version}.exe`)
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: app, ...opts })
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(r.status ?? 1) }
}

const makensis = [process.env.MAKENSIS, 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].filter(Boolean).find((p) => fs.existsSync(p))
if (!makensis) { console.error('NSIS not found: install it or set MAKENSIS to makensis.exe'); process.exit(1) }

if (!process.argv.includes('--skip-build')) run(process.execPath, [path.join(app, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'])

// ---- stage: the Electron runtime, renamed, with the app in resources/app
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
const dist = path.join(app, 'node_modules', 'electron', 'dist')
fs.cpSync(dist, stage, { recursive: true })
const keepLocales = new Set(['en-US.pak', 'tr.pak'])
for (const f of fs.readdirSync(path.join(stage, 'locales'))) if (!keepLocales.has(f)) fs.rmSync(path.join(stage, 'locales', f))
fs.rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true })
const exe = path.join(stage, 'BALTA Crucible.exe')
fs.renameSync(path.join(stage, 'electron.exe'), exe)

const appDir = path.join(stage, 'resources', 'app')
fs.mkdirSync(path.join(appDir, 'build'), { recursive: true })
fs.cpSync(path.join(app, 'out'), path.join(appDir, 'out'), { recursive: true })
for (const f of ['icon.png', 'icon.ico']) fs.copyFileSync(path.join(app, 'build', f), path.join(appDir, 'build', f))
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'balta-crucible', productName: 'BALTA Crucible', version, description: pkg.description, author: 'BALTA Robotics', main: './out/main/index.js' }, null, 2))

// ---- the robot integration tool and its library, next to the app (run with ELECTRON_RUN_AS_NODE=1)
const tool = path.join(stage, 'resources', 'integrator')
fs.mkdirSync(tool, { recursive: true })
fs.copyFileSync(path.join(app, 'scripts', 'integrate-robot.mjs'), path.join(tool, 'integrate-robot.mjs'))
fs.copyFileSync(path.join(app, 'installer', 'patch-robot.ps1'), path.join(tool, 'patch-robot.ps1'))
fs.copyFileSync(path.join(repo, 'docs', 'ROBOT_INTEGRATION.md'), path.join(tool, 'ROBOT_INTEGRATION.md'))
fs.cpSync(path.join(repo, 'robot-lib'), path.join(tool, 'robot-lib'), { recursive: true })

// ---- brand the executable (icon, name, version) with rcedit
try {
  const rcedit = path.join(app, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
  const v = `${version}.0`
  run(rcedit, [exe, '--set-icon', path.join(app, 'build', 'icon.ico'), '--set-version-string', 'ProductName', 'BALTA Crucible', '--set-version-string', 'FileDescription', 'BALTA Crucible',
    '--set-version-string', 'CompanyName', 'BALTA Robotics', '--set-version-string', 'LegalCopyright', 'BALTA Robotics', '--set-version-string', 'OriginalFilename', 'BALTA Crucible.exe',
    '--set-version-string', 'InternalName', 'BALTA Crucible', '--set-file-version', v, '--set-product-version', v])
} catch (e) { console.warn('rcedit failed, the executable keeps the Electron icon:', e) }

// ---- NSIS
run(makensis, ['/V2', `/DVERSION=${version}`, `/DSTAGE=${stage}`, `/DOUTFILE=${installer}`, `/DRES=${path.join(app, 'installer')}`, path.join(app, 'installer', 'installer.nsi')])
const mb = (fs.statSync(installer).size / 1048576).toFixed(1)
console.log(`\nbuilt ${installer} (${mb} MB)`)
