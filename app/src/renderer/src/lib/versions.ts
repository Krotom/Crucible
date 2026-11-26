// Version numbers, the update check's comparison, and the "what's new" log.
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

/** -1, 0 or 1; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

export interface Release { version: string; title: string; items: string[] }

/** Newest first. Add an entry for each release. */
export const CHANGELOG: Release[] = [
  { version: '1.2.0', title: 'Live view for matches, and the field rebuilt from the official CAD', items: [
    'Live view (match): a second pair of eyes for the driver. Connect to the robot and see the field and the robot from its own data, with no physics and no game pieces: smooth robot motion, the turret, hood and intake, camera presets, and a big readout with the match clock, which HUB is active and when it changes, and whether the robot is ready to shoot. It subscribes to a few topics at 20 Hz (editable in the Live view topics field), so it stays light on the field network. Esc leaves it',
    'The field is built from the official FIRST CAD (FE-2026 REBUILT Playing Field): a 7 MB model made by tools/build-field.mjs is drawn in the live view and in REBUILT sims (View: Collision shapes shows the physics bodies instead). docs/FIELD.md explains where every number comes from',
    'Physics from the CAD: the HUB is a hexagonal funnel narrowing to a throat 0.395 m below the 1.829 m rim (it was a square opening), the BUMP is the real gable (15 mm at the edges, 0.1654 m at the crest), the TOWER and the 1.99 m alliance walls exist, and the DEPOTS are 0.1 m from where they were. A quick aim sweep still scores 47 of 48',
    'FUEL starts exactly where the CAD puts it: 360 in the neutral zone (a 12 by 30 grid, it was 408) and 24 in each DEPOT',
    'The simulated AprilTag camera uses the official 2026 layout of 32 tags (it was a guess of 14), which agrees with the CAD to 3.3 mm',
  ] },
  { version: '1.1.9', title: 'Faster shots in the sim, robot definition follows the new motor layout', items: [
    'The shooter flywheel is heavier in the robot definition (inertia 0.1 instead of 0.01 kg m^2, still a guess): one shot now dips it by less than the ready tolerance, so the robot code keeps feeding and the simulated robot fires about 18 to 20 balls per second standing (it was about 9). The flywheel takes about 2 seconds to spin up; set shooter inertia in robots/offseason/robot.yaml to change it',
    'Robot definition: the feeder has two motors (count 2). The motor ids are numbered from 0 in the order of the robot code and marked TODO until the real CAN ids are known: the robot code and robot.yaml must use the same ids or the app reports motors the robot does not register',
    'The robot library example (EmuIOs) follows the robot project: the motor configs moved into the subsystem folders and the flywheel config is one config',
  ] },
  { version: '1.1.8', title: 'Shots in counter, pose fix against walls, two-controller robot library', items: [
    'The scoreboard overlay (B) and the Robot section of the sim panel show how many launches of the robot went into a HUB ("6 of 9 shots in"), apart from the match score',
    'The robot library (SimBridge) keeps the pose of the robot code on the physics while the robot is held by a wall with the stick pushed: while the wheels slip the exact pose is applied at every message and with a near-exact std (the estimator only moved about half way to each correction, so the pose crept past the wall at 0.1 m/s and the shoot-on-the-move aim crept out of the HUB). Needs the robot library of the OffSeasonCode protonme branch',
    'The one gamepad of the app is shown to the robot as both joystick 0 and joystick 1, so robot code with a separate driver and operator controller works',
    'npm run sweep: SWEEP_CROSS=1 records where each ball crosses the HUB opening height, and SWEEP_DIR (tangent, toward, away) picks the driving direction of the moving trials',
  ] },
  { version: '1.1.7', title: 'Memory leak fixed: landing markers', items: [
    'Fixed the memory growth (7 GB in ten minutes of shooting): once there were more than 150 shots, every frame rebuilt the landing markers of the older ones and dropped them without freeing their graphics buffers. Only the newest 150 shots get a marker now, and markers and shot arcs free their graphics memory when they leave the scene',
    'The FUEL drawn inside the robot (1.1.6) is removed',
    'Step works in lockstep: it runs 10 ms of simulated time (every robot cycle in between) and pauses again',
    'The Windows in-app update is still automatic but no longer silent: the installer shows its progress window (no wizard pages, it keeps the install folder and closes itself when it is done, and the new app starts)',
    'npm run diag starts the app with a memory diagnostics log (diag-*.jsonl in the logs folder of the app\'s settings folder: process memory, the 3D view\'s object counts, what the controls were set to, and what you clicked); node scripts/diag-report.mjs summarises it',
  ] },
  { version: '1.1.6', title: 'FUEL inside the robot, a more realistic flywheel, and the aim sweep', items: [
    'Held FUEL is drawn inside the robot in the 3D view: the pieces moving through the intake and feeder, and the hopper\'s pieces as a pile on the tray',
    'Each shot takes the ball\'s kinetic energy out of the flywheel (shooter energyEfficiency 0.6, a guess), so it slows a little at every shot and the robot code feeds the next one when it has recovered: shots no longer come out at 28 per second',
    'Mechanisms with a friction voltage: the turret, shooter, feeder and hood use the robot code\'s own kS as friction. Without it the flywheel ran 3% above its target, which put shots over the HUB',
    'npm run sweep: the real robot code in lockstep shoots at the HUB from a grid of places, standing and driving, and writes the score rate by distance and speed to runs/sweep/latest.md',
    'The robot library copy is refreshed (it reads the app\'s pose message)',
    'Needs the robot code of the OffSeasonCode protonme branch (commit 882eee7 or later): its shot tables come from tools/shot_tables.js and match the sim; the old calculator tables do not',
  ] },
  { version: '1.1.5', title: 'CRITICAL BUGFIX: the robot code\'s position no longer drifts from the physics', items: [
    'CRITICAL: the robot code\'s position (odometry) kept counting wheel turns while the robot was held by a wall, the HUB or another robot, so it ran away from the physics (8 s against the HUB: 26.6 m against 3.6 m). Turret aim, shot tables and shoot on the move all work from that position, so they aimed at the wrong place. The app now sends the robot its exact pose about every 50 ms with the camera off, and the simulated camera\'s noisy pose with it on, and the robot library applies it as a vision measurement (needs the robot library of the OffSeasonCode combined branch: older robot code ignores the message and drifts as before)',
    'Why it matters for your results: shots, aim and shoot-on-the-move tests made on 1.1.4 or earlier were made with a position that could be metres wrong',
  ] },
  { version: '1.1.4', title: 'Memory use, two-wheel shooter, hood zero 10.33', items: [
    'Much less memory: the live data keeps 15,000 samples per topic instead of 60,000 and stores a run of equal values as two samples (a robot with about 400 topics took the page past 2 GB), and the robot trail in the 3D view no longer leaves a graphics buffer behind at every update',
    'The robot program\'s Java heap is capped at 1 GB (a variable set on the Robot tab still wins)',
    'The shooter is modelled as the flywheel plus the two small top wheels (the ball leaves at the mean of their surface speeds: effective radius 0.0494 m, efficiency 0.96, backspin 0.114). Still a guess: fit it to real shots in Tune > Calibration',
    'The launch angle at hood zero is 10.33 degrees (was 15) and the ball leaves the shooter at 0.60 m. Robot code with a generated HoodTable needs 0.013 rotations added to every row (or a re-export with hood zero 10.33), or its shots fly about 5 degrees flatter',
  ] },
  { version: '1.1.3', title: 'Hood scale, turret model in lockstep, 80 FUEL', items: [
    'The robot model\'s turret, hood and intake now move in lockstep runs too (the app did not read their poses there, so the turret stayed in its CAD rest pose and looked at the wrong place)',
    'Hood scale follows Burak\'s generated HoodTable: launch angle = 15 degrees + 360 degrees per hood rotation (the sim used 80 - 10 per rotation, which sent every shot almost straight up). Robot code that still uses the older 0.5 to 3.0 rotation hood table will now aim too flat: it needs that table converted',
    'Shot efficiency 0.78 (was 0.85): the generated shooter table needs a slightly slower exit speed. Still a guess: fit it to real shots in Tune > Calibration',
    'The robot holds up to 80 FUEL (the revolver is modelled as a hopper) instead of 3',
  ] },
  { version: '1.1.2', title: 'The Windows in-app update works', items: [
    'Windows: the in-app update quit the app and then did nothing, because the helper that runs the installer could not start. It is rebuilt (PowerShell, started so that it outlives the app and has a console), writes crucible-update.log next to the download, and starts the old version again when the install fails',
    'Windows will ask for permission to install during an update: allow it. Copies older than 1.1.2 still have the fault: install 1.1.2 once by hand (the installer .exe of this release); updates after that work from inside the app',
    'The silent installer stops at once, instead of waiting for a click nobody can see, when a copy of the app is still open',
  ] },
  { version: '1.1.1', title: 'Aim fixes, robot launch and a faster 3D view', items: [
    'Robot code in lockstep now knows where it stands and which way it faces after every sim start, Reset and Start match (it kept the old position and doubled its heading), so the turret aims at the HUB from any start',
    'Shot efficiency 0.85 (was 0.70): the robot code\'s own shot tables now score from about 1.6 to 4 m in the sim. Still a guess: fit it to real shots in Tune > Calibration',
    'The app stops the robot program it started when it quits, so no robot simulation is left holding the robot\'s ports',
    'Robot launch: names the program that holds the robot\'s ports and offers "Stop the old robot"; Gradle uses WPILib\'s own JDK when it is installed',
    'The scripted cyclers fire from inside their own alliance zone and get through the FUEL pile',
    'The robot model draws as a few dozen meshes instead of about 10,000: the 3D view is several times faster',
    'The Windows installer shows Turkish text correctly',
  ] },
  { version: '1.1.0', title: 'Robot tab, analysis and testing tools', items: [
    'Robot tab: launcher, live Gradle log with error navigation, clickable source links, past runs',
    'Analysis tab: match summary, shot map, timeline, event breakpoints, compare runs, seed sweep',
    'Tune tab: floor and shot parameters, calibration from measured data, guess badges',
    'Robot testing: battery sag, injected faults, mechanism inspector, gamepad remapping, test scenarios',
    'Simulated AprilTag camera (the robot library does not read it yet)',
    'Ctrl+K command palette, session presets, toasts, Turkish interface (partial), colour-blind-safe colours and large text',
  ] },
]

/** The entries to show a user who last saw `lastSeen` (null = never): everything newer than it up to the current version. */
export function entriesSince(lastSeen: string | null, current: string, log: Release[] = CHANGELOG): Release[] {
  return log.filter((r) => (compareVersions(r.version, current) ?? 1) <= 0 && (lastSeen === null || (compareVersions(r.version, lastSeen) ?? 1) > 0))
}

export interface ReleaseAsset { name: string; url: string; size: number }
export interface UpdateResult { status: 'newer' | 'current' | 'none' | 'error'; latest?: string; url?: string; notes?: string; error?: string; /** the files of the release (https download addresses only) */ assets?: ReleaseAsset[] }

/** Reads a GitHub "latest release" API answer. 404 means the repository has no release yet. */
export function interpretRelease(current: string, httpStatus: number, body: unknown): UpdateResult {
  if (httpStatus === 404) return { status: 'none' }
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'error', error: `The update server answered ${httpStatus}` }
  const b = body as { tag_name?: unknown; html_url?: unknown; body?: unknown; assets?: unknown } | null
  const tag = typeof b?.tag_name === 'string' ? b.tag_name : ''
  const cmp = compareVersions(tag, current)
  if (cmp === null) return { status: 'error', error: `Unreadable version "${tag}" from the update server` }
  const url = typeof b?.html_url === 'string' && /^https:\/\//.test(b.html_url) ? b.html_url : undefined
  const assets: ReleaseAsset[] = []
  for (const a of Array.isArray(b?.assets) ? (b!.assets as unknown[]) : []) {
    const x = a as { name?: unknown; browser_download_url?: unknown; size?: unknown }
    if (typeof x?.name === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(x.name) && typeof x.browser_download_url === 'string' && isAllowedUrl(x.browser_download_url) && typeof x.size === 'number' && x.size >= 0) assets.push({ name: x.name, url: x.browser_download_url, size: x.size })
  }
  return cmp > 0 ? { status: 'newer', latest: tag.replace(/^v/, ''), url, assets, notes: typeof b?.body === 'string' ? b.body.slice(0, 1000) : undefined } : { status: 'current', latest: tag.replace(/^v/, '') }
}

/** Download addresses the updater accepts: https, or http on this computer (the test server). */
export function isAllowedUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost')) } catch { return false }
}
