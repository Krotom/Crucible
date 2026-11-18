// What the robot process is doing, worked out from its output: starting, building, running, failed, stopped, exited.
// Pure state (no DOM), fed with the Gradle / robot output lines and the events around them, so it can be tested.

export type RunPhase = 'idle' | 'starting' | 'building' | 'running' | 'failed' | 'stopped' | 'exited'
export type RunTone = 'dim' | 'busy' | 'ok' | 'bad'

export class RobotRun {
  phase: RunPhase = 'idle'
  startedAt = 0
  endedAt = 0
  /** Gradle tasks seen so far. */
  tasks = 0
  exitCode: number | null = null
  /** The sim is connected to the robot program (set from the bridge status). */
  connected = false
  private userStopped = false
  private sawFailure = false
  private couldNotStart = false

  get active(): boolean { return this.phase === 'starting' || this.phase === 'building' || this.phase === 'running' }

  start(now: number): void {
    this.phase = 'starting'
    this.startedAt = now
    this.endedAt = 0
    this.tasks = 0
    this.exitCode = null
    this.connected = false
    this.userStopped = false
    this.sawFailure = false
    this.couldNotStart = false
  }

  /** The process could not even be started (no robot project, no gradlew). */
  launchFailed(now: number): void {
    this.phase = 'failed'
    this.couldNotStart = true
    this.endedAt = now
  }

  /** The user pressed Stop: the exit that follows is expected, not a failure. */
  stop(): void { this.userStopped = true }

  feed(line: string): void {
    if (!this.active) return
    if (/^BUILD FAILED|^FAILURE:/.test(line)) this.sawFailure = true
    if (this.phase === 'running') return
    if (/^> Task :simulateJava\b/.test(line) || /Robot program starting/i.test(line)) { this.phase = 'running'; return }
    if (/^> Task :/.test(line)) { this.tasks++; this.phase = 'building' }
  }

  exit(code: number | null, now: number): void {
    this.endedAt = now
    this.exitCode = code
    this.connected = false
    this.phase = this.userStopped ? 'stopped' : code === 0 && !this.sawFailure ? 'exited' : 'failed'
  }

  elapsed(now: number): number {
    if (this.startedAt === 0) return 0
    return Math.max(0, ((this.endedAt || now) - this.startedAt) / 1000)
  }

  get tone(): RunTone {
    switch (this.phase) {
      case 'starting': case 'building': return 'busy'
      case 'running': return 'ok'
      case 'failed': return 'bad'
      default: return 'dim'
    }
  }

  get label(): string {
    switch (this.phase) {
      case 'idle': return 'Not running'
      case 'starting': return 'Starting…'
      case 'building': return this.tasks > 1 ? `Building… (${this.tasks} tasks)` : 'Building…'
      case 'running': return this.connected ? 'Running · connected to the sim' : 'Running · waiting for the sim'
      case 'stopped': return 'Stopped'
      case 'exited': return 'Exited'
      case 'failed': return this.couldNotStart ? 'Could not start' : this.sawFailure && (this.exitCode === 0 || this.exitCode === null) ? 'Build failed' : `Failed (exit code ${this.exitCode})`
    }
  }
}

export function formatElapsed(seconds: number): string {
  const s = Math.floor(seconds)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
