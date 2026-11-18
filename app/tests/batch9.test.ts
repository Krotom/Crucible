import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gameFromModule, PLUGIN_FILE, validateGameModule } from '../src/engine/plugin'
import { createTestGame } from '../src/games/test'
import { ApiServer, newToken } from '../src/main/api'
import { REPORT_DIR, safeReportName, writeProjectReport } from '../src/main/projectfiles'
import { AttemptLog, margin, statsOf, type Attempt } from '../src/renderer/src/lib/attempts'
import { makeRunFile, parseRunFile, RUN_FORMAT } from '../src/renderer/src/lib/runfile'
import { BoardEditor, BoardStore, emptyBoard, makeStroke, pathLength, startHeadingDeg } from '../src/renderer/src/lib/strategy'
import type { KeyValueStore } from '../src/renderer/src/lib/presets'
import { MatchRecorder } from '../src/renderer/src/lib/analysis'

const memory = (): KeyValueStore & { data: Record<string, string> } => { const data: Record<string, string> = {}; return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v } } }
const FIELD = { length: 16.54, width: 8.07 }

describe('attempts scoreboard', () => {
  const at = (n: number, own: 'blue' | 'red', blue: number, red: number): Attempt => ({ at: n, label: 'm' + n, own, blue, red, duration: 160, shots: 10, accuracy: 0.5, fouls: 0, note: '' })
  it('keeps attempts in time order, ignores a repeat of the same one, and scores from the team side', () => {
    const l = new AttemptLog(memory()); l.add(at(2, 'red', 10, 30)); l.add(at(1, 'blue', 20, 5)); expect(l.add(at(1, 'blue', 99, 99))).toBe(false)
    expect(l.list().map((a) => a.at)).toEqual([1, 2]); expect(margin(l.list()[0])).toBe(15); expect(margin(l.list()[1])).toBe(20)
  })
  it('computes best, mean, record and the trend of the last three against the three before', () => {
    const list = [10, 10, 10, 20, 20, 20].map((s, i) => at(i, 'blue', s, 5))
    expect(statsOf(list)).toMatchObject({ n: 6, best: 20, worst: 10, mean: 15, wins: 6, losses: 0, trend: 10 })
    expect(statsOf(list.slice(0, 5)).trend).toBeNull(); expect(statsOf([])).toMatchObject({ n: 0, best: null, mean: null })
    expect(statsOf([at(1, 'blue', 5, 5), at(2, 'blue', 1, 9)])).toMatchObject({ ties: 1, losses: 1 })
  })
  it('edits notes, removes, clears, caps the size of a note, and survives damaged storage', () => {
    const s = memory(), l = new AttemptLog(s); l.add(at(1, 'blue', 1, 0)); expect(l.setNote(1, 'x'.repeat(500))).toBe(true); expect(l.list()[0].note).toHaveLength(200); expect(l.setNote(9, 'n')).toBe(false)
    expect(l.remove(1)).toBe(true); expect(l.remove(1)).toBe(false); l.add(at(2, 'blue', 1, 0)); l.clear(); expect(l.list()).toEqual([])
    s.data['crucible-attempts'] = '[1,"x",{"at":"no"},{"at":5,"blue":"x"}]'; expect(l.list()).toEqual([{ at: 5, label: 'match', own: 'blue', blue: 0, red: 0, duration: 0, shots: 0, accuracy: null, fouls: 0, note: '' }])
    s.data['crucible-attempts'] = '{oops'; expect(l.list()).toEqual([]); expect(new AttemptLog(null).add(at(1, 'blue', 1, 1))).toBe(false)
  })
  it('keeps only the latest 200 and writes CSV with quoting', () => {
    const l = new AttemptLog(memory()); for (let i = 0; i < 205; i++) l.add(at(i + 1, 'blue', i, 0)); expect(l.list()).toHaveLength(200); expect(l.list()[0].at).toBe(6)
    const c = new AttemptLog(memory()); c.add({ ...at(1, 'red', 10, 30), label: 'a "b", c', note: 'line' }); const rows = c.csv().trim().split('\n'); expect(rows[0]).toContain('margin'); expect(rows[1]).toContain('"a ""b"", c"'); expect(rows[1]).toContain(',red,30,10,20,')
  })
  it('summarises a real recorder run into an attempt-sized set of numbers', () => {
    const r = new MatchRecorder(); const s = r.summary(); expect(typeof s.blue).toBe('number'); expect(s.fouls).toEqual([]); expect(s.shots.accuracy).toBeNull()
  })
})

describe('shareable run file', () => {
  const report = { name: 'r', game: 'test', seed: 7, duration: 30, step: 0.002, final: { blue: 12, red: 3 }, scoreTimeline: [], captures: [], launches: [], shots: 2, scoredShots: 1, accuracy: 0.5, bursts: [], cycleTimes: [], meanCycle: null, carryTimes: [], distance: 4, maxSpeed: 3, maxZ: 1, hits: { count: 0, hardest: 0 }, enabledSeconds: 20, status: {}, samples: [] } as never
  it('round-trips the set-up and the report', () => {
    const f = makeRunFile({ seed: '7', 'bat-on': true, opponent: 'blocker' }, report, '1.1.0', 'practice 4', new Date('2026-01-02T03:04:05Z'))
    const back = parseRunFile(JSON.stringify(f)); expect(back.ok).toBe(true); if (!back.ok) return
    expect(back.hasSetup).toBe(true); expect(back.file.setup).toEqual({ seed: '7', 'bat-on': true, opponent: 'blocker' }); expect(back.file.report.final).toEqual({ blue: 12, red: 3 }); expect(back.file.note).toBe('practice 4'); expect(back.file.created).toBe('2026-01-02T03:04:05.000Z')
  })
  it('opens a plain report.json too (no set-up) and says what is wrong with anything else', () => {
    const plain = parseRunFile(JSON.stringify(report)); expect(plain.ok && !plain.hasSetup).toBe(true)
    expect(parseRunFile('{nope')).toEqual({ ok: false, error: 'not valid JSON' }); expect(parseRunFile('[]')).toMatchObject({ ok: false }); expect(parseRunFile('{"a":1}')).toMatchObject({ ok: false, error: 'not a Crucible run file' })
    expect(parseRunFile(JSON.stringify({ format: RUN_FORMAT, version: 99, report }))).toMatchObject({ ok: false, error: expect.stringContaining('newer version') })
    expect(parseRunFile(JSON.stringify({ format: RUN_FORMAT, version: 1, report: { x: 1 } }))).toMatchObject({ ok: false, error: expect.stringContaining('damaged') })
    expect(parseRunFile('x'.repeat(9 * 1024 * 1024))).toMatchObject({ ok: false, error: expect.stringContaining('too large') })
  })
  it('keeps only safe set-up entries: plain control ids with short text or boolean values', () => {
    const f = { format: RUN_FORMAT, version: 1, report, setup: { seed: '1', 'bad id': 'x', '<script>': 'x', num: 5, long: 'y'.repeat(300), ok: false, nested: { a: 1 } } }
    const r = parseRunFile(JSON.stringify(f)); expect(r.ok && r.file.setup).toEqual({ seed: '1', ok: false })
  })
})

describe('strategy board', () => {
  it('thins and clamps a stroke and drops a dot', () => {
    const s = makeStroke([[1, 1], [1.01, 1], [2, 1], [2, 1.005], [99, -5]], FIELD, '#fff')!
    expect(s.pts).toEqual([[1, 1], [2, 1], [16.54, 0]]); expect(makeStroke([[1, 1], [1.01, 1.01]], FIELD, '#fff')).toBeNull(); expect(makeStroke([[NaN, 1], [1, 1]], FIELD, '#fff')).toBeNull()
    expect(pathLength(s)).toBeCloseTo(1 + Math.hypot(14.54, 1), 6)
    expect(makeStroke(Array.from({ length: 5000 }, (_, i) => [i * 0.003, 1] as [number, number]), { length: 100, width: 10 }, '#fff')!.pts.length).toBeLessThanOrEqual(600)
  })
  it('gives the heading of the first stretch', () => {
    expect(startHeadingDeg({ pts: [[1, 1], [1, 2]], color: '' })).toBeCloseTo(90); expect(startHeadingDeg({ pts: [[0, 0], [1, 0], [1, 5]], color: '' })).toBeCloseTo(0); expect(startHeadingDeg({ pts: [[0, 0], [0.1, 0]], color: '' })).toBeNull()
  })
  it('edits with undo for every kind of change; markers are numbered and the numbers are reused', () => {
    const e = new BoardEditor(emptyBoard(), FIELD)
    expect(e.addMarker(2, 2, '#fff')?.label).toBe('1'); e.addMarker(3, 3, '#fff'); e.addMarker(4, 4, '#fff'); expect(e.board.markers.map((m) => m.label)).toEqual(['1', '2', '3'])
    expect(e.eraseNear(3.1, 3.1)).toBe(true); expect(e.addMarker(5, 5, '#fff')?.label).toBe('2'); expect(e.eraseNear(12, 7)).toBe(false)
    e.addStroke([[1, 1], [3, 1]], '#fff'); expect(e.board.strokes).toHaveLength(1); expect(e.addStroke([[1, 1]], '#fff')).toBe(false)
    e.moveMarker(0, 99, 99); expect(e.board.markers[0]).toMatchObject({ x: 16.54, y: 8.07 })
    e.clear(); expect(e.board.markers).toHaveLength(0); expect(e.canUndo).toBe(true)
    while (e.undo()) { /* all the way back */ } expect(e.board.markers).toHaveLength(0); expect(e.board.strokes).toHaveLength(0); expect(e.canUndo).toBe(false)
  })
  it('refuses to grow without limit: at most 60 markers', () => { const e = new BoardEditor(emptyBoard(), FIELD); for (let i = 0; i < 70; i++) e.addMarker(1, 1, '#fff'); expect(e.board.markers).toHaveLength(60) })
  it('stores boards by name (case-insensitive replace), cleans damaged ones, and refuses empty names', () => {
    const s = memory(), st = new BoardStore(s, FIELD), ed = new BoardEditor(emptyBoard('Auto 1'), FIELD); ed.addMarker(2, 2, '#fff'); ed.addStroke([[1, 1], [4, 4]], '#fff')
    expect(st.save(ed.board)).toBeNull(); expect(st.save({ ...ed.board, name: 'auto 1' })).toBeNull(); expect(st.list()).toHaveLength(1); expect(st.get('AUTO 1')?.markers).toHaveLength(1); expect(st.save({ ...ed.board, name: '  ' })).toMatch(/name/)
    s.data['crucible-boards'] = JSON.stringify([{ name: 'x', strokes: [{ pts: [[0, 0], [1, 1], 'bad'] }, 5], markers: [{ x: 'a' }, { x: 1, y: 2 }], note: 7 }, { name: '' }, null]); const l = st.list(); expect(l).toHaveLength(1); expect(l[0].strokes).toHaveLength(1); expect(l[0].markers).toEqual([{ x: 1, y: 2, label: '1', color: '#e6a50a' }]); expect(l[0].note).toBe('')
    expect(st.delete('x')).toBe(true); expect(st.delete('x')).toBe(false); s.data['crucible-boards'] = '{oops'; expect(st.list()).toEqual([])
  })
})

describe('report into the robot project', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crucible-proj-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('writes into crucible/reports and creates the folders', async () => {
    const r = await writeProjectReport(dir, 'report-1.html', new TextEncoder().encode('<html>hi</html>')); expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, ...REPORT_DIR, 'report-1.html'), 'utf8')).toBe('<html>hi</html>')
  })
  it('cannot climb out of the folder or write other kinds of file', async () => {
    for (const bad of ['../../evil.html', '/etc/cron.d/x.txt', 'a/b/../../../c.json', '..\\..\\win.html', '.bashrc', 'run.sh', 'x.js', '', 5, null]) {
      const name = safeReportName(bad)
      if (name !== null) expect(name).not.toMatch(/[\\/]|^\./) // a sanitised result must be a plain name
    }
    expect(safeReportName('../../evil.html')).toBe('evil.html'); expect(safeReportName('.bashrc')).toBeNull(); expect(safeReportName('run.sh')).toBeNull(); expect(safeReportName('a b?.csv')).toBe('a_b_.csv')
    const r = await writeProjectReport(dir, '../../escape.html', new Uint8Array([1])); expect(r.ok && r.path.startsWith(join(dir, ...REPORT_DIR))).toBe(true)
    expect(readdirSync(join(dir, ...REPORT_DIR))).toEqual(['escape.html'])
  })
  it('explains itself when there is no project, a bad name, or the file is huge', async () => {
    expect(await writeProjectReport(null, 'a.html', new Uint8Array(1))).toMatchObject({ ok: false, error: expect.stringContaining('No robot project') }); expect(await writeProjectReport(dir, 'a.exe', new Uint8Array(1))).toMatchObject({ ok: false })
    expect(await writeProjectReport(dir, 'big.json', new Uint8Array(33 * 1024 * 1024))).toMatchObject({ ok: false, error: expect.stringContaining('too large') })
  })
})

describe('local API', () => {
  let api: ApiServer, port = 0, token = ''
  const calls: unknown[] = []
  const req = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string }): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { ...(opts.host ? { Host: opts.host } : {}), ...opts.headers } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode!, json: JSON.parse(b) }) } catch { resolve({ status: res.statusCode!, json: b }) } }) })
    r.on('error', reject); if (opts.body) r.write(opts.body); r.end()
  })
  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}` })
  beforeEach(async () => {
    token = newToken(); calls.length = 0
    api = new ApiServer(token, async (c) => { calls.push(c); if (c.action === 'boom') throw new Error('it broke'); if (c.action === 'hang') return new Promise(() => {}); return { echo: c.action, time: 1.5 } }, 300) // a short timeout: the test of a handler that never answers should not wait the real 8 s
    port = await api.start(0)
  })
  afterEach(async () => { await api.stop() })

  it('listens on the loopback address only', async () => { expect(api.listening).toBe(true); expect(port).toBeGreaterThan(0); await api.stop(); expect(api.listening).toBe(false); await expect(req({ path: '/api/status' })).rejects.toThrow() })
  it('refuses requests without the right token (none, wrong, other scheme)', async () => {
    expect((await req({ path: '/api/status' })).status).toBe(401); expect((await req({ path: '/api/status', headers: { Authorization: 'Bearer nope' } })).status).toBe(401); expect((await req({ path: '/api/status', headers: { Authorization: `Basic ${token}` } })).status).toBe(401); expect(calls).toEqual([])
  })
  it('refuses browser requests (Origin) and foreign Host headers even with the token', async () => {
    expect((await req({ path: '/api/status', headers: { ...auth(), Origin: 'http://evil.example' } })).status).toBe(403); expect((await req({ path: '/api/status', headers: auth(), host: 'evil.example' })).status).toBe(403)
    expect((await req({ path: '/api/status', headers: auth(), host: `localhost:${port}` })).status).toBe(200); expect(calls).toHaveLength(1)
  })
  it('serves status and commands, and reports errors, bad input, unknown routes and wrong methods in words', async () => {
    expect((await req({ path: '/api/status', headers: auth() })).json).toEqual({ ok: true, result: { echo: 'status', time: 1.5 } })
    const ok = await req({ method: 'POST', path: '/api/command', headers: auth(), body: '{"action":"reset","extra":1}' }); expect(ok.status).toBe(200); expect(calls.at(-1)).toEqual({ action: 'reset', extra: 1 })
    expect((await req({ method: 'POST', path: '/api/command', headers: auth(), body: '{"action":"boom"}' })).json).toEqual({ ok: false, error: 'it broke' })
    expect((await req({ method: 'POST', path: '/api/command', headers: auth(), body: 'nope' })).status).toBe(400); expect((await req({ method: 'POST', path: '/api/command', headers: auth(), body: '{"action":"Bad Action!"}' })).status).toBe(400); expect((await req({ method: 'POST', path: '/api/command', headers: auth(), body: '[]' })).status).toBe(400)
    expect((await req({ path: '/api/nothing', headers: auth() })).status).toBe(404); expect((await req({ method: 'POST', path: '/api/status', headers: auth(), body: '{}' })).status).toBe(405); expect((await req({ path: '/api/command', headers: auth() })).status).toBe(405)
  })
  it('caps the request body', async () => { const r = await req({ method: 'POST', path: '/api/command', headers: auth(), body: JSON.stringify({ action: 'x', pad: 'a'.repeat(70 * 1024) }) }); expect(r.status).toBe(413) })
  it('gives up on a handler that never answers (gateway timeout)', async () => { const r = await req({ method: 'POST', path: '/api/command', headers: auth(), body: '{"action":"hang"}' }); expect(r.status).toBe(504) })
  it('makes long random tokens', () => { expect(newToken()).toMatch(/^[0-9a-f]{48}$/); expect(newToken()).not.toBe(newToken()) })
})

describe('game plugins', () => {
  it('accepts the built-in test game as a plugin', () => { expect(validateGameModule(createTestGame())).toBeNull(); expect('game' in gameFromModule({ default: createTestGame })).toBe(true); expect('game' in gameFromModule({ createGame: createTestGame })).toBe(true) })
  it('explains what is wrong with a broken module', () => {
    const good = createTestGame()
    expect(validateGameModule(null)).toMatch(/object/); expect(validateGameModule({})).toMatch(/id/); expect(validateGameModule({ ...good, field: undefined })).toMatch(/field/)
    expect(validateGameModule({ ...good, field: () => ({ length: 0, width: 5, colliders: [], sensors: [] }) })).toMatch(/length/)
    expect(validateGameModule({ ...good, field: () => ({ length: 8, width: 5, colliders: [{ center: [1], half: [1, 1, 1] }], sensors: [] }) })).toMatch(/collider/)
    expect(validateGameModule({ ...good, pieces: () => [{ id: 'b', radius: 0, mass: 1 }] })).toMatch(/piece/)
    expect(validateGameModule({ ...good, matchFlow: () => ({ phases: [] }) })).toMatch(/phases/); expect(validateGameModule({ ...good, matchFlow: () => ({ phases: [{ name: 'a', duration: -1 }] }) })).toMatch(/phases/)
    expect(validateGameModule({ ...good, initialLayout: () => [{ spec: 'ghost', position: [0, 0, 0] }] })).toMatch(/unknown piece "ghost"/); expect(validateGameModule({ ...good, hud: () => ({}) })).toMatch(/title/)
    expect(validateGameModule({ ...good, field: () => { throw new Error('kaboom') } })).toMatch(/kaboom/)
  })
  it('refuses a module that exports no function, or whose function throws', () => {
    expect(gameFromModule({})).toMatchObject({ error: expect.stringContaining('export a function') }); expect(gameFromModule(null)).toMatchObject({ error: expect.stringContaining('export') })
    expect(gameFromModule({ default: () => { throw new Error('nope') } })).toMatchObject({ error: expect.stringContaining('threw: nope') }); expect(gameFromModule({ default: () => ({}) })).toMatchObject({ error: expect.stringContaining('id') })
  })
  it('only accepts plain .js file names', () => {
    for (const ok of ['rapid.js', 'My-Game_2.js', 'a.b.js']) expect(PLUGIN_FILE.test(ok), ok).toBe(true)
    for (const bad of ['../x.js', 'a/b.js', '.hidden.js', 'x.ts', 'x.js.exe', '', 'a b.js', 'x'.repeat(70) + '.js']) expect(PLUGIN_FILE.test(bad), bad).toBe(false)
  })
})

describe('CI workflow', () => {
  const yml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
  it('only calls npm scripts that exist, in the app folder', () => {
    for (const m of yml.matchAll(/npm run ([\w:-]+)/g)) expect(pkg.scripts[m[1]], `npm run ${m[1]}`).toBeTruthy()
    expect(yml).toMatch(/working-directory: app/); expect(yml).toMatch(/npm ci/); expect(yml).toMatch(/npx vitest run/)
  })
  it('runs the UI suites through the same script as a developer, under a virtual display, and only references files that exist', () => {
    expect(yml).toMatch(/bash e2e\/run\.sh/); expect(yml).toMatch(/xvfb/); expect(readFileSync(new URL('../e2e/run.sh', import.meta.url), 'utf8')).toMatch(/xvfb-run/)
    expect(yml).toMatch(/app\/package-lock\.json/); expect(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8').length).toBeGreaterThan(100)
  })
  it('fetches the Electron binary explicitly before the UI suites (npm ci alone left dist/electron missing on the runner)', () => {
    const install = yml.indexOf('node node_modules/electron/install.js'), run = yml.indexOf('bash e2e/run.sh')
    expect(install).toBeGreaterThan(0); expect(install).toBeLessThan(run); expect(yml).toMatch(/test -x node_modules\/electron\/dist\/electron/)
    expect(readFileSync(new URL('../e2e/run.sh', import.meta.url), 'utf8')).toMatch(/Electron binary missing/)
  })
  it('runs every UI suite in the repository as its own job, with timeouts, and cancels a run that a newer push replaces', () => {
    const suites = [...readdirSync(new URL('../e2e/', import.meta.url)).filter((f) => /^ui-.*\.js$/.test(f)).map((f) => f.replace(/\.js$/, '')), 'robot-ui'].sort()
    const listed = /suite: \[([^\]]+)\]/.exec(yml)![1].split(',').map((x) => x.trim()).sort()
    expect(listed).toEqual(suites)
    expect(yml).toMatch(/cancel-in-progress: true/); expect(yml).toMatch(/E2E_VERBOSE: '1'/); expect(yml).toMatch(/fail-fast: false/)
    expect((yml.match(/timeout-minutes:/g) ?? []).length).toBe(2) // checks and the UI jobs
    const rel = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
    expect((rel.match(/runs-on:/g) ?? []).length).toBe((rel.match(/timeout-minutes:/g) ?? []).length) // no job without a timeout
  })
  it('does not run twice for one push (pushes to branches run as the pull request)', () => {
    expect(yml).toMatch(/push:\n\s+branches: \[main\]/); expect(yml).toMatch(/pull_request:/)
  })
  it('is plain valid YAML structure: jobs with names, runs-on and steps, no tabs', () => {
    expect(yml).not.toMatch(/\t/); expect(yml).toMatch(/^jobs:\n {2}\w+:\n {4}name:/m); expect((yml.match(/runs-on:/g) ?? []).length).toBe(2); expect(yml).not.toMatch(/needs: checks/) // the UI jobs run beside the unit tests, not after them
  })
})
