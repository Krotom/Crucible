import { describe, expect, it } from 'vitest'
import { SourceTracker, classifyLine, findSourceRefs, stripAnsi } from '../src/renderer/src/lib/robotlog'

describe('ANSI stripping', () => {
  it('removes color and cursor codes but keeps the text', () => {
    expect(stripAnsi('\u001b[31mred text\u001b[0m and plain')).toBe('red text and plain')
    expect(stripAnsi('\u001b[1;38;5;208mbold orange\u001b[m')).toBe('bold orange')
    expect(stripAnsi('progress 50%\r')).toBe('progress 50%')
    expect(stripAnsi('\u001b[2K\u001b[1GDone')).toBe('Done')
    expect(stripAnsi('plain line')).toBe('plain line')
  })
  it('classifies the stripped text, so a colored ERROR still reads as an error', () => {
    expect(classifyLine(stripAnsi('\u001b[31mBUILD FAILED\u001b[0m'))).toBe('error')
  })
})

describe('robot log line classification', () => {
  it('marks a successful build green and a failed one red', () => {
    expect(classifyLine('BUILD SUCCESSFUL in 12s')).toBe('ok')
    expect(classifyLine('BUILD FAILED in 3s')).toBe('error')
    expect(classifyLine('FAILURE: Build failed with an exception.')).toBe('error')
    expect(classifyLine('* What went wrong:')).toBe('error')
  })
  it('marks errors and stack frames', () => {
    expect(classifyLine('ERROR: Could not connect')).toBe('error')
    expect(classifyLine('java.lang.IllegalStateException: no bridge')).toBe('error')
    expect(classifyLine('\tat frc.robot.Robot.robotInit(Robot.java:42)')).toBe('error')
    expect(classifyLine('launch failed: spawn ./gradlew ENOENT')).toBe('error')
  })
  it('marks warnings', () => {
    expect(classifyLine('WARNING: Driver Station not connected')).toBe('warn')
    expect(classifyLine('warning: [deprecation] foo() in Bar has been deprecated')).toBe('warn')
  })
  it('leaves ordinary output alone', () => {
    expect(classifyLine('> Task :compileJava')).toBe('info')
    expect(classifyLine('Robot program starting')).toBe('info')
  })
})

describe('build / robot output split', () => {
  it('everything before the simulateJava task is build output, from there on it is the robot', () => {
    const t = new SourceTracker()
    expect(['> Task :compileJava', '> Task :processResources', '> Task :simulateJava', 'robot says hi', '> Task :other'].map((l) => t.next(l))).toEqual(['build', 'build', 'build', 'robot', 'robot'])
    t.reset(); expect(t.next('hello')).toBe('build')
  })
  it('also starts the robot at its startup banner', () => {
    const t = new SourceTracker()
    expect(t.next('********** Robot program starting **********')).toBe('build'); expect(t.next('next')).toBe('robot')
  })
})

describe('source references', () => {
  it('finds a stack frame and points at the file and line inside the parentheses', () => {
    const text = '\tat frc.robot.Robot.robotInit(Robot.java:42)'
    const r = findSourceRefs(text)
    expect(r).toHaveLength(1); expect(text.slice(r[0].start, r[0].end)).toBe('Robot.java:42'); expect(r[0]).toMatchObject({ file: 'Robot.java', line: 42 })
  })
  it('finds a compiler message with a path, and a Windows path', () => {
    const a = 'src/main/java/frc/robot/Shooter.java:17: error: cannot find symbol'
    const ra = findSourceRefs(a); expect(a.slice(ra[0].start, ra[0].end)).toBe('src/main/java/frc/robot/Shooter.java:17'); expect(ra[0]).toMatchObject({ file: 'Shooter.java', line: 17 })
    const b = 'C:\\proj\\src\\main\\java\\frc\\Arm.kt:9: warning'
    expect(findSourceRefs(b)[0]).toMatchObject({ file: 'Arm.kt', line: 9 })
  })
  it('finds several frames in one line and nothing in ordinary text', () => {
    expect(findSourceRefs('a(One.java:1) b(Two.java:2)').map((x) => x.file)).toEqual(['One.java', 'Two.java'])
    expect(findSourceRefs('BUILD SUCCESSFUL in 3s')).toEqual([]); expect(findSourceRefs('see notes.txt:4')).toEqual([]); expect(findSourceRefs('version 1.2:3')).toEqual([])
  })
})
