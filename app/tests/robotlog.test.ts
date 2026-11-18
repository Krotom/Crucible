import { describe, expect, it } from 'vitest'
import { classifyLine, stripAnsi } from '../src/renderer/src/lib/robotlog'

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
