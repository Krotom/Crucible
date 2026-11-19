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
