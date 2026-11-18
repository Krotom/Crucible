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

export interface UpdateResult { status: 'newer' | 'current' | 'none' | 'error'; latest?: string; url?: string; notes?: string; error?: string }

/** Reads a GitHub "latest release" API answer. 404 means the repository has no release yet. */
export function interpretRelease(current: string, httpStatus: number, body: unknown): UpdateResult {
  if (httpStatus === 404) return { status: 'none' }
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'error', error: `The update server answered ${httpStatus}` }
  const b = body as { tag_name?: unknown; html_url?: unknown; body?: unknown } | null
  const tag = typeof b?.tag_name === 'string' ? b.tag_name : ''
  const cmp = compareVersions(tag, current)
  if (cmp === null) return { status: 'error', error: `Unreadable version "${tag}" from the update server` }
  const url = typeof b?.html_url === 'string' && /^https:\/\//.test(b.html_url) ? b.html_url : undefined
  return cmp > 0 ? { status: 'newer', latest: tag.replace(/^v/, ''), url, notes: typeof b?.body === 'string' ? b.body.slice(0, 1000) : undefined } : { status: 'current', latest: tag.replace(/^v/, '') }
}
