// Copies the robot-side bridge library from the OffSeason robot project (where it is developed and tested against real robot code) into
// robot-lib/ in this repo, which is what scripts/integrate-robot.mjs installs into other robot projects.
//   node scripts/sync-robot-lib.mjs [path to the robot project, default ../../OffSeasonCode/OffSeasonCode]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(app, '..')
const robot = path.resolve(process.argv[2] ?? path.join(repo, '..', 'OffSeasonCode', 'OffSeasonCode'))
const javaRoot = path.join(robot, 'src', 'main', 'java', 'frc', 'robot')
const out = path.join(repo, 'robot-lib', 'java')

/** What a robot project needs from the library (EmuIOs is OffSeason's own and stays an example). */
export const LIB_FILES = ['lib/simbridge/FrameCodec.java', 'lib/simbridge/SimBridge.java', 'lib/simbridge/WsServer.java', 'lib/simbridge/EmuTalon.java', 'lib/simbridge/EmuSwerve.java', 'lib/TalonFXSim.java']
export const EXAMPLE_FILES = ['lib/simbridge/EmuIOs.java']

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('sync-robot-lib.mjs')) {
  if (!fs.existsSync(javaRoot)) { console.error(`robot project not found at ${robot}`); process.exit(2) }
  for (const f of LIB_FILES) {
    const dest = path.join(out, f)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, fs.readFileSync(path.join(javaRoot, f), 'utf8').replace(/\r\n/g, '\n'))
    console.log(`robot-lib/java/${f}`)
  }
  for (const f of EXAMPLE_FILES) {
    const dest = path.join(repo, 'robot-lib', 'examples', path.basename(f) + '.txt')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, fs.readFileSync(path.join(javaRoot, f), 'utf8').replace(/\r\n/g, '\n'))
    console.log(`robot-lib/examples/${path.basename(f)}.txt`)
  }
}
