// The robot integration tool (scripts/integrate-robot.mjs) on a small made-up robot project, and the robot library copy against its source.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve(__dirname, '../scripts/integrate-robot.mjs')

function run(dir: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [script, dir, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`integrate failed: ${r.stdout}${r.stderr}`)
  return r.stdout
}

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-fixture-'))
  const w = (rel: string, text: string): void => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  w('build.gradle', 'plugins { id "java" }\n\n// Simulation configuration (e.g. environment variables).\nwpi.sim.addGui().defaultEnabled = true\n')
  w('src/main/java/team/robot/Robot.java', 'package team.robot;\n\nimport edu.wpi.first.wpilibj.TimedRobot;\nimport team.robot.generated.TunerConstants;\n\npublic class Robot extends TimedRobot {\n  private final CommandSwerveDrivetrain drivetrain = TunerConstants.createDrivetrain();\n  public Robot() {\n    drivetrain.registerTelemetry(logger::telemeterize);\n\n    other();\n  }\n}\n')
  w('src/main/java/team/robot/generated/TunerConstants.java', 'package team.robot.generated;\npublic class TunerConstants { public static Object FrontLeft, FrontRight, BackLeft, BackRight; }\n')
  w('src/main/java/team/robot/CommandSwerveDrivetrain.java', 'package team.robot;\n\nimport com.ctre.phoenix6.Utils;\n\npublic class CommandSwerveDrivetrain extends TunerSwerveDrivetrain {\n  public CommandSwerveDrivetrain() {\n    if (Utils.isSimulation()) {\n        startSimThread();\n    }\n  }\n}\n')
  w('src/main/java/team/robot/Mechanism.java', 'package team.robot;\nclass Mechanism { Object m = new TalonFX(12); Object n = new TalonFX(Constants.ID); }\n')
  return dir
}

describe('integrate-robot', () => {
  it('check mode lists what is missing and changes nothing', () => {
    const dir = fixture()
    const before = fs.readFileSync(path.join(dir, 'src/main/java/team/robot/Robot.java'), 'utf8')
    const out = run(dir)
    expect(out).toContain('Base package: team.robot')
    expect(out).toContain('[todo] copy the bridge library')
    expect(out).toContain('[todo] add the bridge block')
    expect(out).toContain('2 `new TalonFX(...)` found')
    expect(fs.readFileSync(path.join(dir, 'src/main/java/team/robot/Robot.java'), 'utf8')).toBe(before)
  })

  it('applies all four changes under the project\'s own package, and a second run changes nothing', () => {
    const dir = fixture()
    run(dir, '--apply')
    const robot = fs.readFileSync(path.join(dir, 'src/main/java/team/robot/Robot.java'), 'utf8')
    expect(robot).toContain('SimBridge.installSwerve(drivetrain, TunerConstants.FrontLeft, TunerConstants.FrontRight, TunerConstants.BackLeft, TunerConstants.BackRight);')
    expect(robot).toContain('import team.robot.lib.simbridge.SimBridge;')
    expect(robot).toContain('import edu.wpi.first.wpilibj.RobotBase;')
    expect(robot.indexOf('registerTelemetry')).toBeLessThan(robot.indexOf('SimBridge.installSwerve'))
    expect(robot.indexOf('SimBridge.installSwerve')).toBeLessThan(robot.indexOf('other();'))
    const dt = fs.readFileSync(path.join(dir, 'src/main/java/team/robot/CommandSwerveDrivetrain.java'), 'utf8')
    expect(dt).toContain('if (Utils.isSimulation() && !SimBridge.isEnabled()) {')
    expect(dt).toContain('startSimThread();')
    expect(fs.readFileSync(path.join(dir, 'build.gradle'), 'utf8')).toContain('defaultEnabled = !"1".equals(System.getenv("CRUCIBLE_BRIDGE"))')
    const lib = fs.readFileSync(path.join(dir, 'src/main/java/team/robot/lib/simbridge/SimBridge.java'), 'utf8')
    expect(lib).toContain('package team.robot.lib.simbridge;')
    expect(lib).not.toContain('frc.robot')
    for (const f of ['FrameCodec', 'WsServer', 'EmuTalon', 'EmuSwerve']) expect(fs.existsSync(path.join(dir, `src/main/java/team/robot/lib/simbridge/${f}.java`))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'src/main/java/team/robot/lib/TalonFXSim.java'))).toBe(true)

    const again = run(dir, '--apply')
    expect(again).not.toContain('added the bridge block')
    expect(again).not.toContain('guarded startSimThread')
    expect(fs.readFileSync(path.join(dir, 'src/main/java/team/robot/Robot.java'), 'utf8').match(/SimBridge\.installSwerve/g)?.length).toBe(1)
    expect(run(dir)).not.toContain('[todo]')
  })

  it('--remove takes the block and the guard out', () => {
    const dir = fixture()
    run(dir, '--apply')
    run(dir, '--remove')
    expect(fs.readFileSync(path.join(dir, 'src/main/java/team/robot/Robot.java'), 'utf8')).not.toContain('installSwerve')
    expect(fs.readFileSync(path.join(dir, 'src/main/java/team/robot/CommandSwerveDrivetrain.java'), 'utf8')).toContain('if (Utils.isSimulation()) {')
  })
})

describe('robot-lib copy', () => {
  it('matches the sources in the OffSeason robot project (node scripts/sync-robot-lib.mjs refreshes it)', () => {
    const src = path.resolve(__dirname, '../../../OffSeasonCode/OffSeasonCode/src/main/java/frc/robot')
    if (!fs.existsSync(src)) return // the robot project is not next to this repository
    for (const f of ['lib/simbridge/FrameCodec.java', 'lib/simbridge/SimBridge.java', 'lib/simbridge/WsServer.java', 'lib/simbridge/EmuTalon.java', 'lib/simbridge/EmuSwerve.java', 'lib/TalonFXSim.java']) {
      const a = fs.readFileSync(path.join(src, f), 'utf8').replace(/\r\n/g, '\n')
      const b = fs.readFileSync(path.resolve(__dirname, '../../robot-lib/java', f), 'utf8')
      expect(b, f).toBe(a)
    }
  })
})

describe('integrate-robot --backup', () => {
  it('copies the original of every changed file to .crucible-backup before changing it', () => {
    const dir = fixture()
    const robotPath = path.join(dir, 'src/main/java/team/robot/Robot.java')
    const original = fs.readFileSync(robotPath, 'utf8')
    run(dir, '--apply', '--backup')
    const root = path.join(dir, '.crucible-backup')
    const stamp = fs.readdirSync(root)[0]
    expect(fs.readFileSync(path.join(root, stamp, 'src/main/java/team/robot/Robot.java'), 'utf8')).toBe(original)
    expect(fs.readFileSync(path.join(root, stamp, 'build.gradle'), 'utf8')).toContain('defaultEnabled = true')
    expect(fs.readFileSync(path.join(root, stamp, 'src/main/java/team/robot/CommandSwerveDrivetrain.java'), 'utf8')).toContain('if (Utils.isSimulation()) {')
  })
})
