// Adds the BALTA Crucible bridge to an existing FRC robot project (Java, WPILib 2026, CTRE Phoenix 6 swerve from Tuner X).
//   node scripts/integrate-robot.mjs <robot project folder>                 check: shows what is there and what would change (changes nothing)
//   node scripts/integrate-robot.mjs <robot project folder> --apply         copies the library in and adds one block to the code that creates the drivetrain
//   options: --package frc.robot   base Java package of the robot project (default: read from Robot.java)
//            --backup              copies every file it is about to change into <project>/.crucible-backup/<time>/ first
//            --remove              takes the block out again (the copied library files stay: delete lib/simbridge and lib/TalonFXSim.java by hand)
// The bridge is simulation only and does nothing unless the environment variable CRUCIBLE_BRIDGE=1 is set (the app sets it when it starts the robot).
// Mechanisms (Talon FX motors that are not part of the swerve drivetrain) are listed with the one line each needs: see docs/ROBOT_INTEGRATION.md.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
// the library sits next to this script when installed with the app, or in robot-lib/ of the repository
const libRoot = [path.join(here, 'robot-lib', 'java'), path.join(repo, 'robot-lib', 'java')].find((p) => fs.existsSync(p)) ?? path.join(repo, 'robot-lib', 'java')
const LIB_FILES = ['lib/simbridge/FrameCodec.java', 'lib/simbridge/SimBridge.java', 'lib/simbridge/WsServer.java', 'lib/simbridge/EmuTalon.java', 'lib/simbridge/EmuSwerve.java', 'lib/TalonFXSim.java']
const MARK = 'BALTA Crucible'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--package')
const apply = args.includes('--apply')
const remove = args.includes('--remove')
const backup = args.includes('--backup')
const pkgArg = args.includes('--package') ? args[args.indexOf('--package') + 1] : null
if (!dir) { console.error('usage: node scripts/integrate-robot.mjs <robot project folder> [--apply|--remove] [--package frc.robot]'); process.exit(2) }

const project = path.resolve(dir)
const javaSrc = path.join(project, 'src', 'main', 'java')
// --backup: the original of every file that is about to change goes to <project>/.crucible-backup/<time>/ (same relative path)
const backupRoot = path.join(project, '.crucible-backup', new Date().toISOString().replace(/[:.]/g, '-'))
function saveBackup(file) {
  if (!backup || !fs.existsSync(file)) return
  const dest = path.join(backupRoot, path.relative(project, file))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
}
const ok = (s) => console.log(`  [ok]   ${s}`)
const todo = (s) => console.log(`  [todo] ${s}`)
const warn = (s) => console.log(`  [!]    ${s}`)
const fail = (s) => { console.error(`error: ${s}`); process.exit(1) }

if (!fs.existsSync(javaSrc)) fail(`${project} has no src/main/java: point this at the robot project folder (the one with build.gradle)`)

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.java')) out.push(p)
  }
  return out
}
const files = walk(javaSrc)
const text = (f) => fs.readFileSync(f, 'utf8')
const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n')

// ---- find the pieces
const robotFile = files.find((f) => path.basename(f) === 'Robot.java')
if (!robotFile) fail('Robot.java not found')
const pkg = pkgArg ?? (text(robotFile).match(/^\s*package\s+([\w.]+)\s*;/m) ?? [])[1]
if (!pkg) fail('could not read the base package from Robot.java (use --package)')
const pkgDir = path.join(javaSrc, ...pkg.split('.'))

// the file that registers telemetry on the drivetrain: that is where the drivetrain is in scope (Robot.java or RobotContainer.java)
const telemetryHits = files.map((f) => ({ f, m: text(f).match(/^([ \t]*)(\w+)\.registerTelemetry\([^;]*\);.*$/m) })).filter((x) => x.m)
const tunerFile = files.find((f) => /class\s+TunerConstants\b/.test(text(f)))
const tunerHasModules = tunerFile && /FrontLeft/.test(text(tunerFile)) && /BackRight/.test(text(tunerFile))
const drivetrainFile = files.find((f) => /extends\s+TunerSwerveDrivetrain\b/.test(text(f)))
const talons = files.flatMap((f) => [...text(f).matchAll(/new\s+TalonFX\s*\(([^)]*)\)/g)].map((m) => ({ f: path.relative(javaSrc, f), id: m[1].trim() })))
// CTRE's template starts its own drivetrain simulation thread in simulation; next to the bridge it would move the wheels a second time
const SIM_THREAD = /if\s*\(\s*Utils\.isSimulation\(\)\s*(?:&&\s*!SimBridge\.isEnabled\(\)\s*)?\)\s*\{(\s*)startSimThread\(\)\s*;/
const simThreadText = drivetrainFile ? text(drivetrainFile) : ''
const simThreadFound = SIM_THREAD.test(simThreadText)
const simThreadGuarded = simThreadFound && /isSimulation\(\)\s*&&\s*!SimBridge\.isEnabled\(\)/.test(simThreadText)
// the simulation GUI would overwrite the app's joystick and Driver Station data every frame, so it stays off while the bridge is on
const gradleFile = path.join(project, 'build.gradle')
const gradleText = fs.existsSync(gradleFile) ? fs.readFileSync(gradleFile, 'utf8') : ''
const GUI_ON = /^([ \t]*)wpi\.sim\.addGui\(\)\.defaultEnabled\s*=\s*true[ \t]*$/m
const guiFound = GUI_ON.test(gradleText)
const guiGuarded = /defaultEnabled\s*=\s*!"1"\.equals\(System\.getenv\("CRUCIBLE_BRIDGE"\)\)/.test(gradleText)
const alreadyLib = fs.existsSync(path.join(pkgDir, 'lib', 'simbridge', 'SimBridge.java'))
const integrated = telemetryHits.some((x) => text(x.f).includes('SimBridge.installSwerve'))

console.log(`Robot project: ${project}`)
console.log(`Base package: ${pkg}\n`)
console.log('Check:')
ok(`Robot.java at ${path.relative(project, robotFile)}`)
if (tunerHasModules) ok(`Tuner X constants at ${path.relative(javaSrc, tunerFile)} (FrontLeft ... BackRight)`); else warn('TunerConstants with FrontLeft/FrontRight/BackLeft/BackRight not found: the swerve step needs the four module constants (see docs/ROBOT_INTEGRATION.md)')
if (drivetrainFile) ok(`drivetrain class ${path.relative(javaSrc, drivetrainFile)} extends TunerSwerveDrivetrain`); else warn('no class extends TunerSwerveDrivetrain: only a CTRE Tuner X swerve drivetrain is handled automatically')
if (telemetryHits.length) ok(`drivetrain created and in scope in ${path.relative(javaSrc, telemetryHits[0].f)} (${telemetryHits[0].m[2]}.registerTelemetry)`); else warn('no `<drivetrain>.registerTelemetry(...)` line found: add the block from docs/ROBOT_INTEGRATION.md where the drivetrain is in scope')
if (simThreadFound) simThreadGuarded ? ok("the drivetrain's own simulation thread is off while the bridge is on") : todo("switch off the template's drivetrain simulation thread while the bridge is on (it would move the wheels a second time)")
else if (drivetrainFile) warn("startSimThread() call not found in the drivetrain class: make sure CTRE's built-in drivetrain simulation does not run when SimBridge.isEnabled()")
if (guiGuarded) ok('build.gradle keeps the simulation GUI off while the bridge is on'); else if (guiFound) todo('build.gradle: keep the simulation GUI off while the bridge is on (it would overwrite the app joystick data)'); else warn('build.gradle has no `wpi.sim.addGui().defaultEnabled = true` line: if you use the simulation GUI, keep it off when CRUCIBLE_BRIDGE=1')
alreadyLib ? ok('library already in the project') : todo('copy the bridge library into the project')
integrated ? ok('bridge block already in the code') : todo('add the bridge block next to the registerTelemetry line')
console.log(`\nMechanisms: ${talons.length} \`new TalonFX(...)\` found (the swerve modules are handled by the block above; the rest need TalonFXSim):`)
for (const t of talons.slice(0, 20)) console.log(`  ${t.f}: TalonFX(${t.id})`)
if (talons.length > 20) console.log(`  ... and ${talons.length - 20} more`)

if (!apply && !remove) { console.log('\nNothing changed. Add --apply to install.'); process.exit(0) }

// ---- remove
if (remove) {
  for (const x of telemetryHits) {
    let s = text(x.f)
    const e = eol(s)
    const re = new RegExp(`${e === '\r\n' ? '\\r\\n' : '\\n'}[ \\t]*// ${MARK}:[^\\n]*\\n[ \\t]*if \\(RobotBase\\.isSimulation\\(\\) && SimBridge\\.isEnabled\\(\\)\\) \\{[\\s\\S]*?\\n[ \\t]*\\}`)
    if (re.test(s)) { s = s.replace(re, ''); fs.writeFileSync(x.f, s); console.log(`\nremoved the block from ${path.relative(project, x.f)}`) }
  }
  if (drivetrainFile && simThreadGuarded) {
    fs.writeFileSync(drivetrainFile, simThreadText.replace(/isSimulation\(\)\s*&&\s*!SimBridge\.isEnabled\(\)/, 'isSimulation()'))
    console.log(`restored the simulation thread call in ${path.relative(project, drivetrainFile)}`)
  }
  process.exit(0)
}

// ---- apply: copy the library (the package name follows the project)
if (!fs.existsSync(libRoot)) fail('robot-lib/ is missing from the Crucible repository (run node scripts/sync-robot-lib.mjs)')
for (const f of LIB_FILES) {
  const dest = path.join(pkgDir, f)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const code = text(path.join(libRoot, f)).replace(/\bfrc\.robot\./g, `${pkg}.`).replace(/^package frc\.robot/m, `package ${pkg}`)
  saveBackup(dest)
  fs.writeFileSync(dest, code)
}
console.log(`\ncopied ${LIB_FILES.length} files into ${path.relative(project, path.join(pkgDir, 'lib'))}`)

// ---- apply: build.gradle
if (guiFound && !guiGuarded) {
  const g = gradleText.replace(GUI_ON, (_m, ind) => `${ind}// With the Crucible app (CRUCIBLE_BRIDGE=1) the app is the driver station and the physics, and the sim GUI would
${ind}// overwrite its joystick data every frame, so the GUI stays off in that mode.
${ind}wpi.sim.addGui().defaultEnabled = !"1".equals(System.getenv("CRUCIBLE_BRIDGE"))`)
  saveBackup(gradleFile)
  fs.writeFileSync(gradleFile, g)
  console.log('changed build.gradle: the simulation GUI is off while the bridge is on')
}

// ---- apply: the drivetrain's own sim thread must not run next to the bridge
if (simThreadFound && !simThreadGuarded) {
  let d = simThreadText.replace(SIM_THREAD, (_m, sp) => `if (Utils.isSimulation() && !SimBridge.isEnabled()) {${sp}startSimThread();`)
  const imp = `import ${pkg}.lib.simbridge.SimBridge;`
  if (!d.includes(imp)) {
    const first = d.match(/^import .*$/m)
    d = first ? d.replace(first[0], imp + eol(d) + first[0]) : d.replace(/^(\s*package .*;)/m, `$1${eol(d)}${eol(d)}${imp}`)
  }
  saveBackup(drivetrainFile)
  fs.writeFileSync(drivetrainFile, d)
  console.log(`guarded startSimThread() in ${path.relative(project, drivetrainFile)}`)
}

// ---- apply: the block
if (!integrated) {
  if (!telemetryHits.length) { warn('could not place the block: no registerTelemetry line. Add this where the drivetrain is in scope:'); printBlock('drivetrain'); process.exit(0) }
  const hit = telemetryHits[0]
  let s = text(hit.f)
  const e = eol(s)
  const indent = hit.m[1]
  const v = hit.m[2]
  const consts = tunerHasModules ? 'TunerConstants.FrontLeft, TunerConstants.FrontRight, TunerConstants.BackLeft, TunerConstants.BackRight' : '/* the four SwerveModuleConstants, front left first */'
  const block = [
    '',
    `${indent}// ${MARK}: hand the drivetrain physics to the simulator app (simulation only; does nothing unless CRUCIBLE_BRIDGE=1)`,
    `${indent}if (RobotBase.isSimulation() && SimBridge.isEnabled()) {`,
    `${indent}  SimBridge.installSwerve(${v}, ${consts});`,
    `${indent}}`,
  ].join(e)
  s = s.replace(hit.m[0], hit.m[0] + block)
  // imports (only what is missing)
  const imports = []
  if (!/import\s+edu\.wpi\.first\.wpilibj\.RobotBase\s*;/.test(s)) imports.push('import edu.wpi.first.wpilibj.RobotBase;')
  if (!new RegExp(`import\\s+${pkg.replace(/\./g, '\\.')}\\.lib\\.simbridge\\.SimBridge\\s*;`).test(s)) imports.push(`import ${pkg}.lib.simbridge.SimBridge;`)
  if (tunerHasModules && !/import\s+[\w.]*TunerConstants\s*;/.test(s) && path.dirname(hit.f) !== path.dirname(tunerFile)) {
    const tpkg = (text(tunerFile).match(/^\s*package\s+([\w.]+)\s*;/m) ?? [])[1]
    if (tpkg) imports.push(`import ${tpkg}.TunerConstants;`)
  }
  if (imports.length) {
    const firstImport = s.match(/^import .*$/m)
    s = firstImport ? s.replace(firstImport[0], imports.join(e) + e + firstImport[0]) : s.replace(/^(\s*package .*;)/m, `$1${e}${e}${imports.join(e)}`)
  }
  saveBackup(hit.f)
  fs.writeFileSync(hit.f, s)
  console.log(`added the bridge block to ${path.relative(project, hit.f)}`)
}

console.log(`\nDone. Next:
  1. Build the robot project once (gradlew build) to check it compiles.
  2. Start the BALTA Crucible app, open the Robot tab, pick "Robot code (real time)" and press Launch robot.
  3. The mechanisms listed above: see docs/ROBOT_INTEGRATION.md ("Mechanisms") for the one line each.`)

function printBlock(v) {
  console.log(`
    if (RobotBase.isSimulation() && SimBridge.isEnabled()) {
      SimBridge.installSwerve(${v}, TunerConstants.FrontLeft, TunerConstants.FrontRight, TunerConstants.BackLeft, TunerConstants.BackRight);
    }`)
}
