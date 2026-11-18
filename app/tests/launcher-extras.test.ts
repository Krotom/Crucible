import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunLog, listLogs, prune, readLog } from '../src/main/logstore'
import { preflight, preflightBlocks } from '../src/main/preflight'
import { chooseRobotDir, findSourceFile, openInEditor, parseEnvText, readConfig, recentRobotDirs, resolveRobotDir, writeConfig } from '../src/main/robot'

const dirs: string[] = []
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-t-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
const project = (root: string, files: Record<string, string> = {}): string => {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, gradlew), '#!/bin/sh\n')
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text) }
  return root
}

describe('environment text', () => {
  it('reads KEY=VALUE lines, skipping blanks and comments, and strips quotes', () => {
    const r = parseEnvText('# a comment\n\nJAVA_HOME=/opt/jdk\nNAME = "two words"\nQ=\'x\'\nEMPTY=\n  SPACED = v  \n')
    expect(r.env).toEqual({ JAVA_HOME: '/opt/jdk', NAME: 'two words', Q: 'x', EMPTY: '', SPACED: 'v' }); expect(r.problems).toEqual([])
  })
  it('keeps everything after the first = and reports unusable lines with their number', () => {
    const r = parseEnvText('A=b=c\nnoequals\n1BAD=x\nGOOD=1')
    expect(r.env).toEqual({ A: 'b=c', GOOD: '1' }); expect(r.problems).toHaveLength(2)
    expect(r.problems[0]).toContain('line 2'); expect(r.problems[1]).toContain('line 3')
  })
})

describe('choosing the robot project', () => {
  it('accepts a folder with gradlew, remembers the last five (newest first, no duplicates) and ranks the user choice above the app folder', () => {
    const user = tmp(), app = tmp(), a = project(path.join(tmp(), 'a')), b = project(path.join(tmp(), 'b'))
    writeConfig(app, { robotDir: a })
    expect(resolveRobotDir(app, [user])).toBe(a)
    expect(chooseRobotDir(user, b)).toEqual({ ok: true, dir: b })
    expect(resolveRobotDir(app, [user])).toBe(b)
    for (let i = 0; i < 6; i++) chooseRobotDir(user, project(path.join(tmp(), `p${i}`)))
    chooseRobotDir(user, a); chooseRobotDir(user, a)
    const recent = recentRobotDirs(user); expect(recent).toHaveLength(5); expect(recent[0]).toBe(a); expect(new Set(recent).size).toBe(5)
    expect(readConfig(user).robotDir).toBe(a)
  })
  it('rejects a missing folder, a file and a folder without gradlew, keeping the old choice', () => {
    const user = tmp(), good = project(path.join(tmp(), 'g')), empty = tmp(), file = path.join(tmp(), 'f.txt'); fs.writeFileSync(file, 'x')
    chooseRobotDir(user, good)
    for (const bad of [path.join(empty, 'nope'), file, empty]) { const r = chooseRobotDir(user, bad); expect(r.ok).toBe(false) }
    expect((chooseRobotDir(user, empty) as { error: string }).error).toContain(gradlew)
    expect(readConfig(user).robotDir).toBe(good)
  })
  it('other config keys survive a write', () => {
    const user = tmp(); writeConfig(user, { editor: 'vim {file}' }); chooseRobotDir(user, project(path.join(tmp(), 'x')))
    expect(readConfig(user).editor).toBe('vim {file}')
  })
})

describe('source lookup and editor', () => {
  it('finds a file by name under src, shallowest first, skipping build folders, and refuses odd names', () => {
    const p = project(path.join(tmp(), 'r'), { 'src/main/java/frc/robot/Robot.java': '', 'src/main/java/frc/robot/deep/er/Robot.java': '', 'src/main/java/build/Hidden.java': '', 'src/main/java/frc/Shooter.java': '' })
    expect(findSourceFile(p, 'Robot.java')).toBe(path.join(p, 'src/main/java/frc/robot/Robot.java'))
    expect(findSourceFile(p, 'Shooter.java')).toBe(path.join(p, 'src/main/java/frc/Shooter.java'))
    expect(findSourceFile(p, 'Hidden.java')).toBeNull(); expect(findSourceFile(p, 'Missing.java')).toBeNull()
    expect(findSourceFile(p, '../../etc/passwd')).toBeNull(); expect(findSourceFile(p, 'a b.java')).toBeNull()
  })
  it('runs the configured editor command with file and line, falls back to VS Code, then the default app', async () => {
    const ran: string[] = [], opened: string[] = []
    const ok = { spawnEditor: async (c: string) => { ran.push(c); return true }, openPath: async (f: string) => { opened.push(f); return '' } }
    expect(await openInEditor('/p/Robot.java', 42, { editor: 'subl {file}:{line}' }, ok)).toEqual({ ok: true, how: 'editor' })
    expect(ran[0]).toBe('subl "/p/Robot.java":42')
    await openInEditor('/p/Robot.java', 7, {}, ok); expect(ran[1]).toBe('code --goto "/p/Robot.java":7')
    await openInEditor('/p/a"b.java', 0, {}, ok); expect(ran[2]).toBe('code --goto "/p/ab.java":1') // quotes removed, line at least 1
    const fail = { spawnEditor: async () => false, openPath: async (f: string) => { opened.push(f); return '' } }
    expect(await openInEditor('/p/Robot.java', 3, {}, fail)).toEqual({ ok: true, how: 'default app' }); expect(opened).toEqual(['/p/Robot.java'])
    expect((await openInEditor('/p/Robot.java', 3, {}, { spawnEditor: async () => false, openPath: async () => 'no app' })).ok).toBe(false)
  })
})

describe('preflight', () => {
  const java = async (): Promise<string | null> => 'openjdk version "17.0.9"'
  const lib = { 'src/main/java/frc/robot/lib/simbridge/SimBridge.java': '', 'src/main/java/frc/robot/Robot.java': 'if (RobotBase.isSimulation() && SimBridge.isEnabled()) {}' }
  it('is all green for a patched project, with the lockstep layer when asked', async () => {
    const p = project(path.join(tmp(), 'ok'), { ...lib, 'src/main/java/frc/robot/lib/simbridge/EmuSwerve.java': '', 'src/main/java/frc/robot/lib/simbridge/EmuTalon.java': '', 'build.gradle': 'wpi.sim.addGui().defaultEnabled = !"1".equals(System.getenv("CRUCIBLE_BRIDGE"))' })
    const c = await preflight(p, true, java)
    expect(c.map((x) => x.id)).toEqual(['project', 'java', 'lib', 'hook', 'gui', 'lockstep']); expect(c.every((x) => x.status === 'ok')).toBe(true); expect(preflightBlocks(c)).toBe(false)
  })
  it('names what is missing: library, hook, GUI guard, lockstep layer', async () => {
    const bare = project(path.join(tmp(), 'bare'), { 'src/main/java/frc/robot/Robot.java': 'class Robot {}', 'build.gradle': 'wpi.sim.addGui().defaultEnabled = true' })
    const c = Object.fromEntries((await preflight(bare, true, java)).map((x) => [x.id, x]))
    expect(c.lib.status).toBe('fail'); expect(c.lib.detail).toContain('SimBridge.java'); expect(c.hook.status).toBe('warn'); expect(c.gui.status).toBe('warn'); expect(c.lockstep.status).toBe('fail')
    const noHook = project(path.join(tmp(), 'nh'), { 'src/main/java/frc/robot/lib/simbridge/SimBridge.java': '', 'src/main/java/frc/robot/Robot.java': 'class Robot {}' })
    expect(Object.fromEntries((await preflight(noHook, false, java)).map((x) => [x.id, x.status])).hook).toBe('fail')
    expect(preflightBlocks(await preflight(bare, false, java))).toBe(false) // missing bridge does not stop a launch, it is reported
  })
  it('blocks on no project and on no Java; a folder without gradlew is a failed project', async () => {
    const none = await preflight(null, false, java); expect(none).toHaveLength(1); expect(preflightBlocks(none)).toBe(true)
    const p = project(path.join(tmp(), 'nojava'), lib)
    const noJava = await preflight(p, false, async () => null); expect(noJava.find((x) => x.id === 'java')!.status).toBe('fail'); expect(preflightBlocks(noJava)).toBe(true)
    const e = tmp(); const c = await preflight(e, false, java); expect(c.find((x) => x.id === 'project')!.status).toBe('fail'); expect(preflightBlocks(c)).toBe(true)
  })
})

describe('run log files', () => {
  it('writes lines to a timestamped file and lists, reads and prunes them', async () => {
    const d = tmp()
    const a = new RunLog(d, new Date('2026-11-18T10:00:00Z')); a.write('first'); a.write('second'); await a.close()
    const b = new RunLog(d, new Date('2026-11-18T11:00:00Z')); b.write('later'); await b.close()
    const names = listLogs(d).map((l) => l.name); expect(names).toEqual(['robot-2026-11-18T11-00-00.log', 'robot-2026-11-18T10-00-00.log'])
    expect(readLog(d, a.name)).toBe('first\nsecond\n')
    prune(d, 1); expect(listLogs(d)).toHaveLength(1)
  })
  it('keeps only the newest 20 runs and refuses to read anything that is not a log name', async () => {
    const d = tmp()
    for (let i = 0; i < 24; i++) { const l = new RunLog(d, new Date(Date.UTC(2026, 10, 1, 0, i))); l.write('x'); await l.close() }
    expect(listLogs(d)).toHaveLength(20)
    for (const bad of ['../x.log', 'robot-..\\x.log', '/etc/passwd', 'notes.txt', 'robot-a/b.log']) expect(readLog(d, bad)).toBeNull()
    expect(readLog(d, 'robot-2000-01-01T00-00-00.log')).toBeNull()
  })
  it('reads only the end of a huge log', async () => {
    const d = tmp(); const l = new RunLog(d, new Date('2026-11-18T12:00:00Z')); for (let i = 0; i < 2000; i++) l.write('line ' + i); await l.close()
    const t = readLog(d, l.name, 1000)!; expect(t.startsWith('[…earlier output cut…]')).toBe(true); expect(t.trimEnd().endsWith('line 1999')).toBe(true); expect(t.length < 1100).toBe(true)
  })
})
