// Packages the app for the platform this runs on: node scripts/package.mjs [--skip-build]   (npm run package)
//   Windows: the NSIS installer (scripts/build-installer.mjs)       -> dist-release/BALTA-Crucible-Setup-<version>.exe
//   Linux:   a folder with the branded Electron runtime + launcher  -> dist-release/BALTA-Crucible-<version>-linux-x64.tar.gz
//   macOS:   BALTA Crucible.app (ad-hoc signed, not notarised)      -> dist-release/BALTA-Crucible-<version>-mac-<arch>.zip
// Everything is built from the Electron runtime in node_modules (so the packaged app runs on exactly the Electron the tests ran on).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(app, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
const version = pkg.version
const outDir = path.join(app, 'dist-release')
const skipBuild = process.argv.includes('--skip-build')
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: app, ...opts })
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(r.status ?? 1) }
}
const tryRun = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', cwd: app }).status === 0

fs.mkdirSync(outDir, { recursive: true })
run(process.execPath, [path.join(app, 'scripts', 'make-icons.mjs')])

if (process.platform === 'win32') {
  run(process.execPath, [path.join(app, 'scripts', 'build-installer.mjs'), ...(skipBuild ? ['--skip-build'] : [])])
  const name = `BALTA-Crucible-Setup-${version}.exe`
  fs.copyFileSync(path.join(app, 'dist-installer', name), path.join(outDir, name))
  console.log(`\npackaged ${path.join(outDir, name)}`)
  process.exit(0)
}

if (!skipBuild) run(process.execPath, [path.join(app, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'])

const electronDist = path.join(app, 'node_modules', 'electron', 'dist')
if (!fs.existsSync(electronDist)) { console.error('the Electron runtime is missing: run  node node_modules/electron/install.js'); process.exit(1) }
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const stageRoot = path.join(app, 'dist-release', 'stage')
fs.rmSync(stageRoot, { recursive: true, force: true })

/** The app itself and the robot integration tool: the same files the Windows installer carries. */
function putApp(resources) {
  const appDir = path.join(resources, 'app')
  fs.mkdirSync(path.join(appDir, 'build'), { recursive: true })
  fs.cpSync(path.join(app, 'out'), path.join(appDir, 'out'), { recursive: true })
  fs.copyFileSync(path.join(app, 'build', 'icon.png'), path.join(appDir, 'build', 'icon.png'))
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'balta-crucible', productName: 'BALTA Crucible', version, description: pkg.description, author: 'BALTA Robotics', main: './out/main/index.js' }, null, 2))
  const tool = path.join(resources, 'integrator')
  fs.mkdirSync(tool, { recursive: true })
  fs.copyFileSync(path.join(app, 'scripts', 'integrate-robot.mjs'), path.join(tool, 'integrate-robot.mjs'))
  fs.copyFileSync(path.join(repo, 'docs', 'ROBOT_INTEGRATION.md'), path.join(tool, 'ROBOT_INTEGRATION.md'))
  fs.cpSync(path.join(repo, 'robot-lib'), path.join(tool, 'robot-lib'), { recursive: true })
}

if (process.platform === 'linux') {
  const folder = `BALTA-Crucible-${version}-linux-${arch}`
  const stage = path.join(stageRoot, folder)
  fs.mkdirSync(stage, { recursive: true })
  fs.cpSync(electronDist, stage, { recursive: true })
  for (const f of fs.readdirSync(path.join(stage, 'locales'))) if (!['en-US.pak', 'tr.pak'].includes(f)) fs.rmSync(path.join(stage, 'locales', f))
  fs.rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true })
  fs.renameSync(path.join(stage, 'electron'), path.join(stage, 'balta-crucible'))
  putApp(path.join(stage, 'resources'))
  fs.copyFileSync(path.join(app, 'build', 'icon.png'), path.join(stage, 'balta-crucible.png'))
  // the launcher: Electron's sandbox needs a root-owned setuid helper, which an unpacked archive cannot have. Without it the app starts with --no-sandbox (the page is the app's own, served from this computer only).
  fs.writeFileSync(path.join(stage, 'BALTA-Crucible'), `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
SANDBOX=""
if [ ! -u "$HERE/chrome-sandbox" ] || [ "$(stat -c %U "$HERE/chrome-sandbox" 2>/dev/null)" != "root" ]; then SANDBOX="--no-sandbox"; fi
exec "$HERE/balta-crucible" $SANDBOX "$@"
`, { mode: 0o755 })
  fs.writeFileSync(path.join(stage, 'balta-crucible.desktop'), `[Desktop Entry]
Type=Application
Name=BALTA Crucible
Comment=Physics simulation and analysis for FRC robot code
Exec=sh -c 'exec "$(dirname "$(readlink -f "%k")")/BALTA-Crucible" "$@"' sh %U
Icon=balta-crucible
Terminal=false
Categories=Education;Science;
`)
  fs.writeFileSync(path.join(stage, 'README.txt'), `BALTA Crucible ${version}
Run ./BALTA-Crucible  (or double-click balta-crucible.desktop after "Allow launching").
The robot integration tool is in resources/integrator (run it with:  ELECTRON_RUN_AS_NODE=1 ./balta-crucible resources/integrator/integrate-robot.mjs <robot project>).
If the window does not open, run it from a terminal and read the message.
`)
  const out = path.join(outDir, `${folder}.tar.gz`)
  run('tar', ['-czf', out, '-C', stageRoot, folder])
  console.log(`\npackaged ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`)
} else if (process.platform === 'darwin') {
  const bundle = path.join(stageRoot, 'BALTA Crucible.app')
  fs.mkdirSync(stageRoot, { recursive: true })
  run('ditto', [path.join(electronDist, 'Electron.app'), bundle]) // ditto keeps the symlinks inside the frameworks
  const macos = path.join(bundle, 'Contents', 'MacOS'), resources = path.join(bundle, 'Contents', 'Resources')
  fs.renameSync(path.join(macos, 'Electron'), path.join(macos, 'BALTA Crucible'))
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true })
  putApp(resources)
  // Info.plist: name, executable, identifier, version
  const plist = path.join(bundle, 'Contents', 'Info.plist')
  tryRun('plutil', ['-convert', 'xml1', plist])
  let p = fs.readFileSync(plist, 'utf8')
  const setKey = (key, value) => { const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`); p = re.test(p) ? p.replace(re, `$1${value}$2`) : p.replace('</dict>\n</plist>', `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>\n</plist>`) }
  setKey('CFBundleDisplayName', 'BALTA Crucible'); setKey('CFBundleName', 'BALTA Crucible'); setKey('CFBundleExecutable', 'BALTA Crucible'); setKey('CFBundleIdentifier', 'com.balta.crucible')
  setKey('CFBundleShortVersionString', version); setKey('CFBundleVersion', version); setKey('NSHumanReadableCopyright', 'BALTA Robotics')
  fs.writeFileSync(plist, p)
  // the icon: png -> iconset -> icns (sips and iconutil are part of macOS)
  const iconset = path.join(stageRoot, 'icon.iconset')
  fs.mkdirSync(iconset, { recursive: true })
  for (const s of [16, 32, 64, 128, 256, 512]) {
    run('sips', ['-z', String(s), String(s), path.join(app, 'build', 'icon.png'), '--out', path.join(iconset, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
    if (s >= 32) fs.copyFileSync(path.join(iconset, `icon_${s}x${s}.png`), path.join(iconset, `icon_${s / 2}x${s / 2}@2x.png`))
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'electron.icns')]) // the plist already points at electron.icns
  // changing the bundle invalidated Electron's signature: sign it again, ad hoc (required to run on Apple silicon; not a Developer ID signature)
  run('codesign', ['--force', '--deep', '--sign', '-', bundle])
  const out = path.join(outDir, `BALTA-Crucible-${version}-mac-${arch}.zip`)
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, out])
  console.log(`\npackaged ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`)
} else { console.error(`unsupported platform ${process.platform}`); process.exit(1) }
fs.rmSync(stageRoot, { recursive: true, force: true })
