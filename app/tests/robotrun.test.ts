import { describe, expect, it } from 'vitest'
import { RobotRun, formatElapsed } from '../src/renderer/src/lib/robotrun'

describe('robot run state', () => {
  it('goes starting -> building -> running from the Gradle output', () => {
    const r = new RobotRun()
    expect(r.label).toBe('Not running')
    r.start(1000)
    expect(r.phase).toBe('starting'); expect(r.tone).toBe('busy')
    r.feed('> Task :compileJava'); r.feed('> Task :processResources'); r.feed('> Task :classes')
    expect(r.phase).toBe('building'); expect(r.label).toBe('Building… (3 tasks)')
    r.feed('> Task :simulateJava')
    expect(r.phase).toBe('running'); expect(r.tone).toBe('ok')
    r.feed('> Task :somethingElse') // running stays running
    expect(r.phase).toBe('running')
  })
  it('knows when the robot program itself says it started, and the sim link', () => {
    const r = new RobotRun(); r.start(0)
    r.feed('********** Robot program starting **********')
    expect(r.phase).toBe('running'); expect(r.label).toBe('Running · waiting for the sim')
    r.connected = true; expect(r.label).toBe('Running · connected to the sim')
  })
  it('tells Stop, a clean exit and a failure apart', () => {
    const stop = new RobotRun(); stop.start(0); stop.feed('> Task :simulateJava'); stop.stop(); stop.exit(143, 5000)
    expect(stop.phase).toBe('stopped'); expect(stop.label).toBe('Stopped')
    const ok = new RobotRun(); ok.start(0); ok.feed('> Task :simulateJava'); ok.exit(0, 100)
    expect(ok.phase).toBe('exited')
    const bad = new RobotRun(); bad.start(0); bad.feed('> Task :compileJava'); bad.exit(1, 100)
    expect(bad.phase).toBe('failed'); expect(bad.label).toBe('Failed (exit code 1)'); expect(bad.tone).toBe('bad')
    const gradle = new RobotRun(); gradle.start(0); gradle.feed('BUILD FAILED in 2s'); gradle.exit(0, 100)
    expect(gradle.phase).toBe('failed'); expect(gradle.label).toBe('Build failed')
  })
  it('reports a launch that never started, and starts clean on the next run', () => {
    const r = new RobotRun(); r.start(0); r.launchFailed(10)
    expect(r.label).toBe('Could not start'); expect(r.active).toBe(false)
    r.start(20); expect(r.phase).toBe('starting'); expect(r.label).toBe('Starting…')
  })
  it('ignores output that arrives after the process ended', () => {
    const r = new RobotRun(); r.start(0); r.exit(0, 10); r.feed('> Task :simulateJava')
    expect(r.phase).toBe('exited')
  })
  it('measures elapsed time up to the exit', () => {
    const r = new RobotRun(); r.start(1000)
    expect(r.elapsed(4500)).toBeCloseTo(3.5)
    r.exit(0, 6000); expect(r.elapsed(99999)).toBe(5)
    expect(formatElapsed(5.9)).toBe('5 s'); expect(formatElapsed(65)).toBe('1:05')
  })
})
