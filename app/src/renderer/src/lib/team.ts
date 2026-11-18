// The DOM side of the team features: the attempts list, the strategy board, shared runs, the local API switch and the game plugin list.
import { AttemptLog, margin, ownScore, otherScore, statsOf, type Attempt } from './attempts'
import { saveBlob, timestampName, type Saver } from './capture'
import { BoardEditor, BoardStore, COLORS, emptyBoard, startHeadingDeg, type Board, type FieldSize } from './strategy'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const SVGNS = 'http://www.w3.org/2000/svg'
const store = (): Storage | null => { try { return localStorage } catch { return null } }
interface Host {
  listGames?: () => Promise<{ file: string }[]>
  openGamesFolder?: () => Promise<string>
  apiGet?: () => Promise<ApiState>
  apiSet?: (e: boolean) => Promise<ApiState>
  apiNewToken?: () => Promise<ApiState>
}
interface ApiState { enabled: boolean; listening: boolean; token: string; port: number; error: string }
const host = (): Host => ((window as unknown as { crucibleHost?: Host }).crucibleHost ?? {})

// ---------------------------------------------------------------- attempts
export const attempts = new AttemptLog(store())

export function renderAttempts(): void {
  const list = attempts.list()
  const s = statsOf(list)
  const stats = $('att-stats')
  stats.textContent = s.n === 0 ? 'No attempts yet: each match that reaches its end is added here.'
    : `${s.n} attempt${s.n === 1 ? '' : 's'} · best ${s.best} · average ${s.mean!.toFixed(1)} · ${s.wins} won, ${s.losses} lost${s.ties ? `, ${s.ties} tied` : ''}` + (s.trend === null ? '' : ` · last 3 ${s.trend >= 0 ? '+' : '−'}${Math.abs(s.trend).toFixed(1)} against the 3 before`)
  const box = $('att-list')
  box.textContent = ''
  for (const a of [...list].reverse()) {
    const row = document.createElement('div'); row.className = 'att-row'; row.dataset.at = String(a.at)
    const t = document.createElement('span'); t.className = 't'; t.textContent = new Date(a.at).toTimeString().slice(0, 5); t.title = new Date(a.at).toLocaleString()
    const l = document.createElement('span'); l.className = 'l'; l.textContent = `${a.label}: ${ownScore(a)}–${otherScore(a)}`; l.title = `${a.own} alliance · ${a.shots} shots${a.accuracy === null ? '' : `, ${Math.round(a.accuracy * 100)}%`} · ${a.fouls} fouls · ${a.duration.toFixed(0)} s`
    const m = document.createElement('span'); const mg = margin(a); m.className = 'm ' + (mg > 0 ? 'pos' : mg < 0 ? 'neg' : ''); m.textContent = `${mg > 0 ? '+' : mg < 0 ? '−' : ''}${Math.abs(mg)}`
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove this attempt'; x.setAttribute('aria-label', 'Remove this attempt'); x.addEventListener('click', () => { attempts.remove(a.at); renderAttempts() })
    const nt = document.createElement('input'); nt.className = 'nt'; nt.placeholder = 'Note…'; nt.value = a.note; nt.maxLength = 200; nt.addEventListener('change', () => { attempts.setNote(a.at, nt.value) })
    row.append(t, l, m, x, nt)
    box.appendChild(row)
  }
}

export function setupAttempts(saveText: (name: string, text: string, mime: string) => Promise<void>): void {
  renderAttempts()
  $('att-csv').addEventListener('click', () => { void saveText(timestampName('balta-crucible-attempts', 'csv'), attempts.csv(), 'text/csv') })
  $('att-clear').addEventListener('click', () => { if (attempts.list().length === 0) return; attempts.clear(); renderAttempts() })
}

export function recordAttempt(a: Attempt): void { if (attempts.add(a)) renderAttempts() }

// ---------------------------------------------------------------- strategy board
type Tool = 'pen' | 'marker' | 'move' | 'erase' | 'start'
const HINTS: Record<Tool, string> = {
  pen: 'Pen: press and drag to draw a path.', marker: 'Marker: click to drop a numbered marker.', move: 'Move: drag a marker.', erase: 'Erase: click a marker or a path.',
  start: 'Start here: click for the start position, drag to also set the heading. It fills the Start position boxes of the Session tab.',
}

export interface BoardHooks { field: () => FieldSize & { sensors?: { center: number[]; half: number[]; alliance?: string }[] }; setStart: (x: number, y: number, yawDeg: number | null) => void; notify: (t: string) => void; saver: Saver | undefined }

export function setupBoard(h: BoardHooks): { open: () => void } {
  const dlg = $<HTMLDialogElement>('board'), svg = document.getElementById('board-svg') as unknown as SVGSVGElement
  let size = h.field()
  let editor = new BoardEditor(emptyBoard('Plan'), size)
  let boards = new BoardStore(store(), size)
  let tool: Tool = 'pen', color = COLORS[0]
  let drag: { kind: 'pen'; pts: [number, number][] } | { kind: 'move'; i: number; x0: number; y0: number } | { kind: 'start'; x: number; y: number } | null = null

  const el = (tag: string, attrs: Record<string, string | number>): SVGElement => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e }
  const Y = (y: number): number => size.width - y
  const draw = (): void => {
    svg.setAttribute('viewBox', `-0.3 -0.3 ${size.length + 0.6} ${size.width + 0.6}`)
    svg.textContent = ''
    svg.appendChild(el('rect', { x: 0, y: 0, width: size.length, height: size.width, fill: 'none', stroke: '#8a919c', 'stroke-width': 0.04 }))
    svg.appendChild(el('line', { x1: size.length / 2, y1: 0, x2: size.length / 2, y2: size.width, stroke: '#8a919c', 'stroke-width': 0.025, 'stroke-dasharray': '0.2 0.2' }))
    for (const s of h.field().sensors ?? []) svg.appendChild(el('rect', { x: s.center[0] - s.half[0], y: Y(s.center[1] + s.half[1]), width: s.half[0] * 2, height: s.half[1] * 2, fill: s.alliance === 'red' ? 'rgba(255,85,102,0.25)' : 'rgba(76,194,255,0.25)', stroke: s.alliance === 'red' ? '#ff5566' : '#4cc2ff', 'stroke-width': 0.03 }))
    const all = [...editor.board.strokes, ...(drag?.kind === 'pen' && drag.pts.length > 1 ? [{ pts: drag.pts, color }] : [])]
    for (const s of all) svg.appendChild(el('polyline', { points: s.pts.map((p) => `${p[0].toFixed(3)},${Y(p[1]).toFixed(3)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 0.09, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.95 }))
    for (const m of editor.board.markers) {
      svg.appendChild(el('circle', { cx: m.x, cy: Y(m.y), r: 0.28, fill: m.color, stroke: '#111', 'stroke-width': 0.04 }))
      const t = el('text', { x: m.x, y: Y(m.y) + 0.11, 'text-anchor': 'middle', 'font-size': 0.32, 'font-weight': 700, fill: '#111', 'font-family': 'sans-serif' }); t.textContent = m.label; svg.appendChild(t)
    }
    if (drag?.kind === 'start') svg.appendChild(el('circle', { cx: drag.x, cy: Y(drag.y), r: 0.2, fill: 'none', stroke: '#5bd490', 'stroke-width': 0.06 }))
    ;($('board-undo') as HTMLButtonElement).disabled = !editor.canUndo
  }
  const toField = (e: PointerEvent): [number, number] => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal
    return [vb.x + ((e.clientX - r.left) / r.width) * vb.width, size.width - (vb.y + ((e.clientY - r.top) / r.height) * vb.height)]
  }
  const nearestMarker = (x: number, y: number): number => { let best = -1, d = 0.6; editor.board.markers.forEach((m, i) => { const k = Math.hypot(m.x - x, m.y - y); if (k < d) { d = k; best = i } }); return best }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const [x, y] = toField(e)
    svg.setPointerCapture(e.pointerId)
    if (tool === 'pen') drag = { kind: 'pen', pts: [[x, y]] }
    else if (tool === 'marker') { editor.addMarker(x, y, color) }
    else if (tool === 'erase') { editor.eraseNear(x, y) }
    else if (tool === 'move') { const i = nearestMarker(x, y); if (i >= 0) drag = { kind: 'move', i, x0: editor.board.markers[i].x, y0: editor.board.markers[i].y } }
    else if (tool === 'start') drag = { kind: 'start', x, y }
    draw()
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return
    const [x, y] = toField(e)
    if (drag.kind === 'pen') drag.pts.push([x, y])
    else if (drag.kind === 'move') { const m = editor.board.markers[drag.i]; m.x = Math.min(size.length, Math.max(0, x)); m.y = Math.min(size.width, Math.max(0, y)) }
    draw()
  })
  const finish = (e: PointerEvent): void => {
    const d = drag; drag = null
    if (!d) return
    const [x, y] = toField(e)
    if (d.kind === 'pen') editor.addStroke(d.pts, color)
    else if (d.kind === 'move') { const m = editor.board.markers[d.i]; m.x = d.x0; m.y = d.y0; /* put it back, then record the move as one undoable change */ editor.moveMarker(d.i, x, y) }
    else if (d.kind === 'start') {
      const dist = Math.hypot(x - d.x, y - d.y)
      h.setStart(d.x, d.y, dist >= 0.3 ? (Math.atan2(y - d.y, x - d.x) * 180) / Math.PI : null)
      h.notify(`Start position set to ${d.x.toFixed(2)}, ${d.y.toFixed(2)}${dist >= 0.3 ? `, heading ${Math.round((Math.atan2(y - d.y, x - d.x) * 180) / Math.PI)}°` : ''}`)
    }
    draw()
  }
  svg.addEventListener('pointerup', finish)
  svg.addEventListener('pointercancel', () => { drag = null; draw() })

  for (const b of dlg.querySelectorAll<HTMLButtonElement>('.bt')) b.addEventListener('click', () => { tool = b.dataset.tool as Tool; for (const o of dlg.querySelectorAll('.bt')) o.classList.toggle('on', o === b); $('board-hint').textContent = HINTS[tool] })
  const colors = $('board-colors')
  for (const c of COLORS) { const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.title = c; b.setAttribute('aria-label', `colour ${c}`); b.className = c === color ? 'on' : ''; b.addEventListener('click', () => { color = c; for (const o of colors.children) o.classList.toggle('on', o === b) }); colors.appendChild(b) }
  $('board-undo').addEventListener('click', () => { editor.undo(); draw() })
  $('board-clear').addEventListener('click', () => { editor.clear(); draw() })

  const fill = (keep?: string): void => {
    const sel = $<HTMLSelectElement>('board-sel'), all = boards.list()
    sel.textContent = ''
    const first = document.createElement('option'); first.value = ''; first.textContent = all.length ? 'Saved boards…' : 'No saved boards yet'; sel.appendChild(first)
    for (const b of all) { const o = document.createElement('option'); o.value = b.name; o.textContent = b.name; sel.appendChild(o) }
    if (keep) sel.value = keep
  }
  $('board-save').addEventListener('click', () => {
    const name = $<HTMLInputElement>('board-name').value || editor.board.name
    const err = boards.save({ ...editor.board, name, note: $<HTMLTextAreaElement>('board-note').value })
    if (err) { $('board-hint').textContent = err; return }
    editor.board.name = name.trim(); $('board-hint').textContent = `Saved "${name.trim()}"`; fill(name.trim())
  })
  $('board-load').addEventListener('click', () => {
    const b = boards.get($<HTMLSelectElement>('board-sel').value)
    if (!b) { $('board-hint').textContent = 'Choose a saved board first'; return }
    editor = new BoardEditor(JSON.parse(JSON.stringify(b)) as Board, size); $<HTMLInputElement>('board-name').value = b.name; $<HTMLTextAreaElement>('board-note').value = b.note; $('board-hint').textContent = `Loaded "${b.name}"`; draw()
  })
  $('board-del').addEventListener('click', () => {
    const n = $<HTMLSelectElement>('board-sel').value
    if (!n) { $('board-hint').textContent = 'Choose a saved board first'; return }
    $('board-hint').textContent = boards.delete(n) ? `Deleted "${n}"` : 'Could not delete it'; fill()
  })
  $('board-path-start').addEventListener('click', () => {
    const s = editor.board.strokes[0]
    if (!s) { $('board-hint').textContent = 'Draw a path first'; return }
    h.setStart(s.pts[0][0], s.pts[0][1], startHeadingDeg(s)); h.notify(`Start position set from the first path: ${s.pts[0][0].toFixed(2)}, ${s.pts[0][1].toFixed(2)}`)
  })
  $('board-png').addEventListener('click', async () => {
    try {
      const vb = svg.viewBox.baseVal, W = 1600, H = Math.round((W * vb.height) / vb.width)
      const clone = svg.cloneNode(true) as SVGSVGElement
      clone.setAttribute('xmlns', SVGNS); clone.setAttribute('width', String(W)); clone.setAttribute('height', String(H))
      const bg = el('rect', { x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: '#15181d' }); clone.insertBefore(bg, clone.firstChild)
      const img = new Image()
      await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('could not draw the board')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone)) })
      const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d')!.drawImage(img, 0, 0, W, H)
      const blob = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('no image'))), 'image/png'))
      const where = await saveBlob(timestampName('balta-crucible-board', 'png'), blob, h.saver)
      h.notify(where ? `Saved ${where}` : 'Save cancelled')
    } catch (e) { h.notify(`Could not save the board: ${(e as Error).message}`) }
  })

  fill()
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  return {
    open: () => {
      size = h.field(); boards = new BoardStore(store(), size)
      if (editor.board.strokes.length === 0 && editor.board.markers.length === 0) editor = new BoardEditor(editor.board, size)
      fill(); draw(); if (!dlg.open) dlg.showModal()
    },
  }
}

// ---------------------------------------------------------------- game plugins and the local API
export async function setupGames(): Promise<void> {
  const sel = $<HTMLSelectElement>('game-select')
  const list = (await host().listGames?.()) ?? []
  for (const g of list) { const o = document.createElement('option'); o.value = `plugin:${g.file}`; o.textContent = `${g.file.replace(/\.js$/, '')} (plugin)`; sel.appendChild(o) }
  // a plugin that was chosen last time is only selectable if its file is still there: the saved value was ignored before the options existed, so restore it now
  try { const saved = (JSON.parse(localStorage.getItem('crucible-settings') ?? '{}') as Record<string, unknown>)['game-select']; if (typeof saved === 'string' && [...sel.options].some((o) => o.value === saved)) sel.value = saved } catch { /* default */ }
  $('games-folder').addEventListener('click', () => { void host().openGamesFolder?.() })
}

export function setupApiPrefs(): void {
  const on = $<HTMLInputElement>('pref-api'), info = $('api-info'), tok = $<HTMLInputElement>('api-token'), note = $('api-note'), ex = $('api-example')
  const paint = (s: ApiState): void => {
    on.checked = s.enabled && s.listening
    info.hidden = !on.checked
    tok.value = s.token
    ex.textContent = `curl -H "Authorization: Bearer ${s.token.slice(0, 8)}…" http://127.0.0.1:${s.port}/api/status\ncurl -X POST -H "Authorization: Bearer <token>" -d '{"action":"reset"}' http://127.0.0.1:${s.port}/api/command`
    note.textContent = s.error ? s.error : s.listening ? 'On: only this computer can reach it, and every request needs the token. Commands: status, start, stop, reset, play, pause, step, preset, set.' : 'Off.'
  }
  const h = host()
  if (!h.apiGet) { on.disabled = true; note.textContent = 'The local API is only available in the desktop app.'; return }
  void h.apiGet().then(paint)
  on.addEventListener('change', async () => { on.disabled = true; paint(await h.apiSet!(on.checked)); on.disabled = false })
  $('api-new').addEventListener('click', async () => paint(await h.apiNewToken!()))
  $('api-copy').addEventListener('click', () => { void navigator.clipboard?.writeText(tok.value).then(() => { note.textContent = 'Token copied.' }, () => { tok.select(); note.textContent = 'Select the token and copy it by hand.' }) })
}
