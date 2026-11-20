// Shot-accuracy sweep: the real robot project in lockstep, shooting at the HUB from a grid of places, standing still and driving.
// One robot process, many trials (the engine is reset and the robot re-seeded between them, as the Reset button does).
// Slow (Gradle start, then a few seconds of wall time per trial), so it only runs with RUN_SWEEP=true:  npm run sweep
// Output: runs/sweep/latest.json and runs/sweep/latest.md (score rate by distance and speed, and how far the robot code's pose strayed from the physics).
// Options (environment): SWEEP_QUICK=1 (a few trials), SWEEP_SPEED (lockstep speed multiple, 0 = as fast as it goes, default 0), SWEEP_ROBOT_DIR.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { BridgeSession } from '../src/engine/bridge/session'
import { Nt4Raw } from '../src/engine/bridge/nt4raw'
import { Nt4Live } from '../src/renderer/src/lib/nt4'
import { DataStore } from '../src/renderer/src/lib/store'
import { decodeStruct } from '../src/renderer/src/lib/structs'
import { createWorld } from '../src/analysis/runner'
import { Recorder, type Launch } from '../src/analysis/recorder'
import { HUB_X, HUB_Y } from '../src/games/rebuilt'
import { OFFSEASON } from '../src/robots/offseason'
import { RobotLauncher, resolveRobotDir, simulateCommand } from '../src/main/robot'

const run = process.env.RUN_SWEEP === 'true'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await wait(20) }
}

async function portFree(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const busy = await new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true) }); s.once('error', () => res(false)) })
    if (!busy) return
    await wait(100)
  }
  throw new Error(`port ${port} stays busy`)
}

interface Trial {
  /** distance from the robot to the HUB centre at the start, m */
  dist: number
  /** bearing of the robot from the HUB, degrees (180 = straight back from the HUB along the field) */
  bearing: number
  yawDeg: number
  /** field-relative speed across the HUB (sideways), m/s; 0 = standing still (RT), else shooting on the move (LT) */
  speed: number
}

interface TrialResult extends Trial {
  shots: number
  scored: number
  /** launch distances to the HUB centre, m */
  launchDist: number[]
  /** every launch: seconds into the trial, exit speed, and whether it scored */
  launches: { t: number; speed: number; scored: boolean; /** launch direction minus the direction to the HUB centre, degrees (left positive) */ azErr: number; /** launch elevation, degrees */ elev: number }[]
  /** the largest distance between the robot code's pose and the physics during the trial, m */
  maxPoseError: number | null
  endPoseError: number | null
  fedBalls: number
}

const SHOOT_SECONDS = 6
const SETTLE = 1.5
/** seconds a moving trial drives before it shoots */
const MOVE_RUN_UP = 0.8

function grid(quick: boolean): Trial[] {
  const out: Trial[] = []
  const dists = quick ? [2.5, 4] : [1.5, 2, 2.5, 3, 3.5, 4]
  const bearings = quick ? [180] : [150, 180, 210]
  const yaws = quick ? [0] : [0, 90]
  const speeds = process.env.SWEEP_SPEEDS ? process.env.SWEEP_SPEEDS.split(',').map(Number) : quick ? [0, 1.5] : [0, 1, 2]
  for (const speed of speeds) for (const dist of dists) for (const bearing of bearings) for (const yawDeg of yaws) {
    if (speed > 0 && (yawDeg !== 0 || bearing !== 180)) continue // the moving trials keep one heading and run along the field, so they stay clear of the walls
    out.push({ dist, bearing, yawDeg, speed })
  }
  return out
}

function startOf(t: Trial): { x: number; y: number; yaw: number } {
  const a = (t.bearing * Math.PI) / 180
  // a moving trial strafes towards +y: start that far back so the robot has reached its speed and is about at the nominal place when the shooting starts
  const run = t.speed > 0 ? -t.speed * (MOVE_RUN_UP + 0.5) : 0
  return { x: HUB_X + t.dist * Math.cos(a), y: HUB_Y + t.dist * Math.sin(a) + run, yaw: (t.yawDeg * Math.PI) / 180 }
}

describe.skipIf(!run)('aim sweep with the real robot code', () => {
  it('shoots at the HUB from a grid of places', async () => {
    const quick = process.env.SWEEP_QUICK === '1'
    const dir = process.env.SWEEP_ROBOT_DIR ?? resolveRobotDir(path.resolve(__dirname, '..'))
    expect(dir).not.toBeNull()
    const lines: string[] = []
    const cmd = simulateCommand()
    const launcher = new RobotLauncher({ cwd: dir!, command: cmd.command, args: cmd.args, env: { ...cmd.env, CRUCIBLE_MODE: 'lockstep' }, onLog: (l) => lines.push(l), onExit: () => {} })
    const outDir = path.resolve(__dirname, '..', 'runs', 'sweep')
    fs.mkdirSync(outDir, { recursive: true })
    const nt = new Nt4Raw('127.0.0.1', 5810)
    const liveStore = new DataStore()
    liveStore.startLive('sweep')
    const live = process.env.SWEEP_TRACE === '1' ? new Nt4Live(liveStore, '127.0.0.1', 5810, () => {}) : null
    let est: number[] | null = null
    let session: BridgeSession | null = null
    const results: TrialResult[] = []
    try {
      await portFree(5811)
      launcher.start()
      const first = startOf({ dist: 3, bearing: 180, yawDeg: 0, speed: 0 })
      const engine = await createWorld({ name: 'sweep', game: 'rebuilt', seed: 1, duration: 1, start: first, preload: 12, neutralFuel: 0, events: [] })
      const speedOpt = Number(process.env.SWEEP_SPEED ?? 0)
      session = new BridgeSession(engine, '127.0.0.1', { ws: 5811, nt: 5810 }, () => {}, OFFSEASON, { dt: 0.005, speed: speedOpt })
      nt.subscribeRaw('/AdvantageKit/RealOutputs/Swerve/Pose', (b) => { const v = decodeStruct('struct:Pose2d', b); if (v) est = Array.from(v as ArrayLike<number>) })
      nt.start()
      live?.start()
      session.start()
      await until(() => session!.status.connected, 400_000, 'the robot to connect')
      await until(() => engine.time >= 0.2, 200_000, 'the first steps')
      session.setDs({ enabled: true, autonomous: false, test: false })

      const trials = grid(quick)
      let seed = 100
      for (const [index, tr] of trials.entries()) {
        engine.setStart(startOf(tr))
        engine.reset(seed++)
        session.seedPose()
        const rec = new Recorder(engine, { name: 'sweep', game: 'rebuilt', seed, duration: SETTLE + SHOOT_SECONDS, step: 0.005, preload: 12 })
        rec.attach()
        const dirs: { t: number; azErr: number; elev: number }[] = []
        const trace = process.env.SWEEP_TRACE === '1' && index === 0
        const tracks = new Map<number, [number, number, number, number][]>()
        const flywheel: [number, number][] = []
        const robotPath: [number, number, number, number][] = []
        const stopObs = engine.observe((e, t) => {
          if (e.type !== 'piece-launched') return
          const az = Math.atan2(e.velocity[1], e.velocity[0]), to = Math.atan2(HUB_Y - e.position[1], HUB_X - e.position[0])
          let d = ((az - to) * 180) / Math.PI
          while (d > 180) d -= 360
          while (d < -180) d += 360
          if (trace) tracks.set(e.pieceId, [])
          dirs.push({ t, azErr: d, elev: (Math.atan2(e.velocity[2], Math.hypot(e.velocity[0], e.velocity[1])) * 180) / Math.PI })
        })
        let maxErr = 0
        let endErr: number | null = null
        const sampleError = (): void => {
          const f = engine.getFrame()
          // the robot's own pose needs a moment to follow a Reset: judge it from 1 s in
          if (est && engine.time > 1) { endErr = Math.hypot(est[0] - f.robot[0], est[1] - f.robot[1]); maxErr = Math.max(maxErr, endErr) }
          rec.sample()
        }
        const end = SETTLE + SHOOT_SECONDS
        session.setJoystick([0, 0, 0, 0, 0, 0], 2n, -1) // B held: idle, whatever state the last trial left the robot in
        // moving trials start strafing right after the idle press, so they are at speed when SETTLE comes
        session.at(SETTLE - MOVE_RUN_UP, () => session!.setJoystick([tr.speed > 0 ? -Math.min(1, tr.speed / 4.0) : 0, 0, 0, 0, 0, 0], 0n, -1))
        session.at(SETTLE, () => {
          // RT = "shooting" (axis 3), LT = "shooting on the move" (axis 2); the sideways speed is the strafe axis (left stick X, negated by the robot code)
          const strafe = tr.speed > 0 ? -Math.min(1, tr.speed / 4.0) : 0
          session!.setJoystick([strafe, 0, tr.speed > 0 ? 1 : 0, tr.speed > 0 ? 0 : 1, 0, 0], 0n, -1)
        })
        for (let t = 0.25; t <= end + 1e-9; t += 0.25) session.at(t, sampleError)
        if (trace) for (let t = 0.2; t <= end; t += 0.1) session.at(t, () => { const f = engine.getFrame(); robotPath.push([+engine.time.toFixed(2), +f.robot[0].toFixed(3), +f.robot[1].toFixed(3), +f.robotSpeed.toFixed(2)]) })
        if (trace) for (let t = SETTLE - 0.5; t <= end; t += 0.02) session.at(t, () => { const m = engine.mechanisms.get(37); if (m) flywheel.push([+engine.time.toFixed(3), +m.rps.toFixed(3)]) })
        if (trace) for (let t = SETTLE; t <= end; t += 0.04) session.at(t, () => { for (const [id, tr] of tracks) { const st = engine.pieceState(id); if (st) tr.push([+engine.time.toFixed(3), +st.position[0].toFixed(3), +st.position[1].toFixed(3), +st.position[2].toFixed(3)]) } })
        session.at(end, () => session!.setJoystick([0, 0, 0, 0, 0, 0], 0n, -1))
        await until(() => engine.time >= end + 0.05, 300_000, `trial ${index + 1} to finish`)
        rec.stop()
        stopObs()
        const rep = rec.report()
        const launches: Launch[] = rep.launches
        results.push({
          ...tr, shots: rep.shots, scored: rep.scoredShots,
          launchDist: launches.map((l) => Math.hypot(l.x - HUB_X, l.y - HUB_Y)),
          launches: launches.map((l, i) => ({ t: +l.t.toFixed(3), speed: +l.speed.toFixed(2), scored: l.scored, azErr: +(dirs[i]?.azErr ?? NaN).toFixed(2), elev: +(dirs[i]?.elev ?? NaN).toFixed(1) })),
          maxPoseError: est ? maxErr : null, endPoseError: est ? endErr : null, fedBalls: rep.captures.length,
        })
        if (trace) {
          const series: Record<string, [number, unknown][]> = {}
          for (const name of liveStore.topicNames().filter((n) => /ReadyToShoot|ShooterReady|HoodReady|TurretReady|DesiredRPM|Shooter[/]|Feeder[/]|Indexer[/]|Turret[/]poses/.test(n))) { const sr = liveStore.series.get(name)!; series[name] = sr.times.map((tt, i) => [+tt.toFixed(3), sr.get(i) as unknown]).filter(([tt]) => (tt as number) > 0) as [number, unknown][] }
          fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify({ tracks: [...tracks.values()], flywheel, series, robotPath }))
        }
        const r = results[results.length - 1]
        console.log(`trial ${index + 1}/${trials.length}: d ${tr.dist} m, bearing ${tr.bearing}, yaw ${tr.yawDeg}, v ${tr.speed}: ${r.scored}/${r.shots} scored, pose error max ${r.maxPoseError?.toFixed(2)} m`)
        fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(results, null, 1))
      }
      fs.writeFileSync(path.join(outDir, 'latest.md'), report(results))
      console.log('\n' + report(results))
      expect(results.length).toBe(trials.length)
    } finally {
      fs.writeFileSync(path.join(outDir, 'robot-gradle.log'), lines.slice(-400).join('\n'))
      nt.stop()
      live?.stop()
      session?.stop()
      await launcher.stop()
      await portFree(5811)
    }
  }, 3_600_000)
})

/** Score rate by distance and speed, plus the worst pose drift. */
export function report(rs: TrialResult[]): string {
  const speeds = [...new Set(rs.map((r) => r.speed))].sort((a, b) => a - b)
  const dists = [...new Set(rs.map((r) => r.dist))].sort((a, b) => a - b)
  const cell = (d: number, v: number): string => {
    const s = rs.filter((r) => r.dist === d && r.speed === v)
    const shots = s.reduce((a, r) => a + r.shots, 0)
    const sc = s.reduce((a, r) => a + r.scored, 0)
    return shots === 0 ? 'no shots' : `${sc}/${shots} (${Math.round((100 * sc) / shots)}%)`
  }
  const out = ['# Aim sweep', '', 'Scored / launched FUEL by robot distance to the HUB centre (rows) and sideways speed in m/s (columns; 0 = standing, RT; else shooting on the move, LT).', '',
    `| distance m | ${speeds.map((v) => `${v} m/s`).join(' | ')} |`, `| --- | ${speeds.map(() => '---').join(' | ')} |`]
  for (const d of dists) out.push(`| ${d} | ${speeds.map((v) => cell(d, v)).join(' | ')} |`)
  const drift = rs.map((r) => r.maxPoseError).filter((x): x is number => x !== null)
  out.push('', `Trials: ${rs.length}. Worst distance between the robot code's pose and the physics: ${drift.length ? Math.max(...drift).toFixed(3) + ' m' : 'not read'}.`)
  const nothing = rs.filter((r) => r.shots === 0)
  if (nothing.length) out.push('', `No shot fired in ${nothing.length} trial(s): ${nothing.map((r) => `d${r.dist} b${r.bearing} y${r.yawDeg} v${r.speed}`).join('; ')}.`)
  return out.join('\n') + '\n'
}
