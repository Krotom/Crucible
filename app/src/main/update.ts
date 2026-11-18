// "Check for updates": asks GitHub for the latest release of the project and compares it with this version. Sends nothing about the user.
import { interpretRelease, type UpdateResult } from '../renderer/src/lib/versions'

export const RELEASES_URL = 'https://api.github.com/repos/krotom/crucible/releases/latest'

export async function checkForUpdate(current: string, fetchFn: typeof fetch = fetch, url = RELEASES_URL): Promise<UpdateResult> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'balta-crucible' }, signal: ctl.signal })
      let body: unknown = null
      try { body = await res.json() } catch { /* an unreadable body is reported by interpretRelease */ }
      return interpretRelease(current, res.status, body)
    } finally { clearTimeout(timer) }
  } catch (e) {
    return { status: 'error', error: (e as Error).name === 'AbortError' ? 'The update server did not answer in time' : `Could not reach the update server: ${(e as Error).message}` }
  }
}
