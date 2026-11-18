import { describe, expect, it } from 'vitest'
import { classifyLine } from '../src/renderer/src/lib/robotlog'

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
