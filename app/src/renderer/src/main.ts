import './style.css'
import { Nt4Live, type NtStatus } from './lib/nt4'
import { PlotPanel } from './lib/plot'
import { installKeyboard, readInput, sameReading, type JoystickReading } from './lib/input'
import type { RenderFrame } from '../../engine/types'
import { SceneView } from './lib/scene'
import { SimSource } from './lib/simsource'
import { DataStore } from './lib/store'
import { isNumericType, type Value } from './lib/structs'
import { parseWpilog } from './lib/wpilog'
import { LogView, SourceTracker } from './lib/robotlog'
import { SimPanel } from './lib/simpanel'
import { buildSimModel, scoreboardModel } from './lib/simmodel'
import { CAMERA_PRESETS, ViewFx, type CameraPreset } from './lib/viewfx'
import { appVersion, dismissSplash, setupAbout, setupCapture, setupShortcutsDialog, setupTabs, setupTheme, showTab } from './lib/chrome'
import { RobotRun, formatElapsed } from './lib/robotrun'
import { MatchRecorder, eventsCsv, reportHtml } from './lib/analysis'
import { AnalysisView, TimelineBar, renderSummary } from './lib/analysis-view'
import { renderCompare } from './lib/compare-view'
import { renderSweep, SweepRunner } from './lib/sweep-ui'
import { TuneUI } from './lib/tune-ui'
import { MechHistory, MechInspector } from './lib/mechhistory'
import { setupControls } from './lib/controls-ui'
import { parseRunReport } from './lib/compare'
import { storeToWpilog } from './lib/wpilogwriter'
import type { RunReport } from '../../analysis/recorder'
import { saveBlob, timestampName, type Saver } from './lib/capture'
import { bindSettings } from './lib/settings'
import { findShortcut, keyName } from './lib/shortcuts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const store = new DataStore()
const refStore = new DataStore() // the reference log, drawn dashed on the plot
const view = new SceneView($('view'))
const fx = new ViewFx(view, $('ruler-label'))
let live: Nt4Live | null = null
let robotHalfZ = 0.12
let robotMode = false
let dsEnabled = false
let lastInput: JoystickReading | null = null
let lastInputSent = 0
const sim = new SimSource(
  store,
  (r) => { analysisView.setField(r.field); robotHalfZ = r.robotHalf[2]; view.setSimField(r.field, r.pieces, r.robotHalf, r.othersHalf); fx.start(r.field, r.gameId); applyViewMenu(); sim.send({ type: 'speed', value: speed }); sendDs() },
  (m) => setStatus(`Sim error: ${m}`),
)

// ---- playback state
let time = 0
let playing = false
let speed = 1
let lockstepMode = false
let lastFrame = performance.now()
let seeking = false

// ---- plot
const plot = new PlotPanel($('plot'), (t) => seekTo(t), () => { renderTopicList(); const none = plot.topics.length === 0; $<HTMLButtonElement>('plot-csv').disabled = none; $<HTMLButtonElement>('plot-png').disabled = none })
plot.build(store, true)

function seekTo(t: number): void {
  if (store.mode !== 'log') return
  time = Math.min(store.tMax, Math.max(store.tMin, t))
}

// ---- topic list
const topicsEl = $('topics')
const filterEl = $<HTMLInputElement>('filter')
const rowByName = new Map<string, { row: HTMLElement; val: HTMLElement }>()

function summarize(v: Value | undefined): string {
  if (v === undefined) return '-'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'boolean' || typeof v === 'string') return String(v).slice(0, 80)
  if (v instanceof Uint8Array) return `${v.length} bytes`
  const a = Array.from(v as ArrayLike<number | string>)
  const shown = a.slice(0, 4).map((x) => (typeof x === 'number' ? x.toFixed(3) : x)).join(', ')
  return `[${a.length}] ${shown}${a.length > 4 ? ', …' : ''}`
}

function renderTopicList(): void {
  const q = filterEl.value.trim().toLowerCase()
  topicsEl.textContent = ''
  rowByName.clear()
  for (const name of store.topicNames()) {
    if (name.includes('/.schema/') || name.startsWith('/.schema') || (q && !name.toLowerCase().includes(q))) continue
    const s = store.series.get(name)!
    const row = document.createElement('div')
    const plottable = isNumericType(s.type)
    row.className = `topic${plottable ? ' plottable' : ''}${plot.has(name) ? ' on' : ''}`
    row.title = name
    const nm = document.createElement('span')
    nm.className = 'name'
    nm.textContent = `‎${name}`
    const ty = document.createElement('span')
    ty.className = 'type'
    ty.textContent = s.type
    const val = document.createElement('span')
    val.className = 'val'
    row.append(nm, ty, val)
    if (plottable) row.addEventListener('click', () => plot.toggle(name, store))
    topicsEl.appendChild(row)
    rowByName.set(name, { row, val })
  }
  if (refStore.mode === 'log') {
    const head = document.createElement('div')
    head.className = 'topic-head'
    head.textContent = `Reference: ${refStore.label}`
    topicsEl.appendChild(head)
    for (const name of refStore.topicNames()) {
      if (name.includes('/.schema/') || name.startsWith('/.schema') || (q && !name.toLowerCase().includes(q))) continue
      const s = refStore.series.get(name)!
      const key = `ref:${name}`
      const plottable = isNumericType(s.type)
      const row = document.createElement('div')
      row.className = `topic ref${plottable ? ' plottable' : ''}${plot.has(key) ? ' on' : ''}`
      row.title = `${name} (reference log)`
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = `‎${name}`
      const ty = document.createElement('span'); ty.className = 'type'; ty.textContent = s.type
      row.append(nm, ty)
      if (plottable) row.addEventListener('click', () => plot.toggle(key, store))
      topicsEl.appendChild(row)
    }
  }
  refreshPoseSelects()
}
filterEl.addEventListener('input', renderTopicList)

// ---- pose pickers
const poseSel = $<HTMLSelectElement>('pose-select')
const compSel = $<HTMLSelectElement>('comp-select')

function fillSelect(sel: HTMLSelectElement, names: string[], prefer: RegExp): void {
  const current = sel.value
  const want = names.includes(current) ? current : (names.find((n) => prefer.test(n)) ?? '')
  sel.textContent = ''
  sel.append(new Option('(none)', ''))
  for (const n of names) sel.append(new Option(n, n))
  sel.value = want
}

function refreshPoseSelects(): void {
  const all = store.topicNames().map((n) => store.series.get(n)!)
  fillSelect(poseSel, all.filter((s) => s.type === 'struct:Pose2d' || s.type === 'struct:Pose3d').map((s) => s.name), /\/RealOutputs\/Swerve\/Pose$|\/Swerve\/Pose$|^\/Sim\/Robot\/Pose$/)
  fillSelect(compSel, all.filter((s) => s.type === 'struct:Pose3d[]').map((s) => s.name), /Mechanism3d\/Components$/)
}

// ---- data sources
function setStatus(text: string, ok = false): void {
  const el = $('status')
  el.textContent = text
  el.classList.toggle('ok', ok)
}

function updateTransportEnabled(): void {
  const isLog = store.mode === 'log'
  const isSim = sim.active
  $<HTMLInputElement>('seek').disabled = !isLog
  $<HTMLButtonElement>('play').disabled = !(isLog || isSim)
  $('sim-buttons').hidden = !isSim
  $('ds-controls').hidden = !(isSim && robotMode)
  $<HTMLButtonElement>('sim-step').disabled = robotMode
  $<HTMLButtonElement>('ruler-btn').disabled = !isSim
  if (!isSim && fx.rulerActive) { fx.setRuler(false); $('ruler-btn').classList.remove('on'); $('ruler-btn').textContent = 'Ruler' }
  applyViewMenu()
  $('simhud').hidden = !(isSim && sim.latest) // shown from the first frame on: nothing stale before it
  if (!isSim) simPanel.clear()
}

function stopSim(): void {
  if (!sim.active) return
  sim.stop()
  view.clearSim()
  fx.stop()
  $('start-sim').textContent = 'Start sim'
  updateTransportEnabled()
}

async function openLogFile(file: File): Promise<void> {
  stopSim()
  live?.stop(); live = null
  $('connect').textContent = 'Connect'
  setStatus(`Reading ${file.name}…`)
  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    const t0 = performance.now()
    const log = parseWpilog(buf)
    store.loadLog(log, file.name)
    time = store.tMin
    playing = false
    $('play').textContent = 'Play'
    plot.clear(store)
    setStatus(`${file.name}: ${store.series.size} topics, ${(store.tMax - store.tMin).toFixed(0)} s${log.truncated ? ' (truncated file)' : ''} - parsed in ${(performance.now() - t0).toFixed(0)} ms`, true)
  } catch (e) {
    setStatus(`Could not open ${file.name}: ${(e as Error).message}`)
  }
  updateTransportEnabled()
}

// ---- reference log
const refOffset = (): number => { const v = Number($<HTMLInputElement>('ref-offset').value.trim().replace(',', '.')); return Number.isFinite(v) ? v : 0 }
plot.setReference(refStore, refOffset)
$('ref-open').addEventListener('click', () => { $<HTMLInputElement>('ref-file').value = ''; $<HTMLInputElement>('ref-file').click() })
$<HTMLInputElement>('ref-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const log = parseWpilog(new Uint8Array(await f.arrayBuffer()))
    if (log.entries.length === 0) throw new Error('no data in the file')
    refStore.loadLog(log, f.name)
    $('ref-name').textContent = f.name
    $('ref-info').hidden = false
    $('notice').textContent = `Reference log ${f.name}: ${refStore.series.size} topics (pick them in the Topics tab)`
    renderTopicList()
  } catch (err) { $('notice').textContent = `Could not open ${f.name} as a reference: ${(err as Error).message}` }
})
$('ref-clear').addEventListener('click', () => {
  refStore.clear(); plot.dropReference(); $('ref-info').hidden = true
  plot.build(store, true); renderTopicList()
})
$('ref-offset').addEventListener('input', () => plot.build(store, true))

$('open-log').addEventListener('click', () => $<HTMLInputElement>('file').click())
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) void openLogFile(f)
})

const dropEl = $('drop')
window.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('show') })
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dropEl.classList.remove('show') })
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dropEl.classList.remove('show')
  const f = e.dataTransfer?.files[0]
  if (f) void openLogFile(f)
})

const statusText: Record<NtStatus, string> = { connecting: 'Connecting…', connected: 'Live', closed: 'Disconnected' }
$('connect').addEventListener('click', () => {
  stopSim()
  if (live) {
    live.stop(); live = null
    $('connect').textContent = 'Connect'
    store.clear(); plot.clear(store)
    setStatus('No data')
    updateTransportEnabled()
    return
  }
  const host = $<HTMLInputElement>('host').value.trim() || '127.0.0.1'
  live = new Nt4Live(store, host, 5810, (s) => setStatus(`NT ${host}: ${statusText[s]}`, s === 'connected'))
  live.start()
  plot.clear(store)
  $('connect').textContent = 'Disconnect'
  updateTransportEnabled()
})

// ---- transport
const seekEl = $<HTMLInputElement>('seek')
const playEl = $<HTMLButtonElement>('play')
playEl.addEventListener('click', togglePlay)
function togglePlay(): void {
  if (sim.active) { sim.send({ type: 'run', running: !sim.running }); return }
  if (store.mode !== 'log') return
  if (!playing && time >= store.tMax) time = store.tMin
  playing = !playing
  playEl.textContent = playing ? 'Pause' : 'Play'
}
$<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  speed = Number((e.target as HTMLSelectElement).value)
  if (sim.active) sim.send({ type: 'speed', value: speed })
})
seekEl.addEventListener('pointerdown', () => { seeking = true })
seekEl.addEventListener('pointerup', () => { seeking = false })
seekEl.addEventListener('input', () => seekTo(store.tMin + Number(seekEl.value) * (store.tMax - store.tMin)))
$('clear-plot').addEventListener('click', () => plot.clear(store))
$('plot-csv').addEventListener('click', () => { void saveText(timestampName('balta-crucible-plot', 'csv'), plot.csv(store), 'text/csv') })
$('plot-png').addEventListener('click', async () => {
  const blob = await plot.png()
  if (!blob) { $('notice').textContent = 'Nothing is plotted yet'; return }
  const where = await saveBlob(timestampName('balta-crucible-plot', 'png'), blob, saver)
  $('notice').textContent = where ? `Saved ${where}` : 'Save cancelled'
})
$('focus').addEventListener('click', () => view.focusRobot())

// ---- simulation
const seedValue = (): number => (Number($<HTMLInputElement>('seed').value) || 0) >>> 0
$('start-sim').addEventListener('click', () => {
  if (sim.active) { stopSim(); store.clear(); plot.clear(store); setStatus('No data'); return }
  live?.stop(); live = null
  $('connect').textContent = 'Connect'
  plot.clear(store)
  lockstepMode = $<HTMLSelectElement>('sim-mode').value === 'lockstep'
  robotMode = $<HTMLSelectElement>('sim-mode').value !== 'script'
  dsEnabled = false
  $('ds-enable').textContent = 'Enable'
  lastInput = null
  simPanel.clear()
  recorder.reset(); mechHistory.clear(); endShown = false
  lastStart = { seed: seedValue(), game: $<HTMLSelectElement>('game-select').selectedOptions[0].textContent ?? '', mode: $<HTMLSelectElement>('sim-mode').selectedOptions[0].textContent ?? '' }
  ownAlliance = $<HTMLSelectElement>('alliance').value === 'red' ? 'red' : 'blue'
  sim.start(seedValue(), lockstepMode ? 'lockstep' : robotMode ? 'robot' : 'script', $<HTMLInputElement>('host').value.trim() || '127.0.0.1', $<HTMLSelectElement>('game-select').value as 'test' | 'rebuilt', $<HTMLSelectElement>('opponent').value as 'none' | 'blocker' | 'cycler' | 'ally' | 'both', Number($<HTMLSelectElement>('step-dt').value), { alliance: ownAlliance, start: startOverrides(), tune: tune.params(), faults: faultsSpec(), battery: batterySpec(), breaks: breakSpec() })
  $('start-sim').textContent = 'Stop sim'
  setStatus(lockstepMode ? 'Sim: robot code, lockstep (Mode B)' : robotMode ? 'Sim: robot code via NT' : 'Sim: game-test (scripted)', true)
  playEl.textContent = 'Play'
  updateTransportEnabled()
})
function sendDs(): void {
  if (!robotMode) return
  const mode = $<HTMLSelectElement>('ds-mode').value
  sim.send({ type: 'ds', enabled: dsEnabled, autonomous: mode === 'auto', test: mode === 'test' })
}
$('ds-enable').addEventListener('click', () => {
  dsEnabled = !dsEnabled
  $('ds-enable').textContent = dsEnabled ? 'Disable' : 'Enable'
  sendDs()
})
$('ds-mode').addEventListener('change', sendDs)
$('match-start').addEventListener('click', () => { dsEnabled = false; $('ds-enable').textContent = 'Enable'; sim.send({ type: 'match', run: true }) })
$('match-end').addEventListener('click', () => sim.send({ type: 'match', run: false }))
installKeyboard()
$('sim-step').addEventListener('click', () => sim.send({ type: 'step', steps: Math.max(1, Math.round(0.01 / (sim.ready?.dt ?? 0.002))) })) // always 10 ms of simulated time, as the button says (the running sim's own step, not the dropdown)
$('sim-reset').addEventListener('click', () => sim.send({ type: 'reset', seed: seedValue() }))
const slotEl = $<HTMLSelectElement>('slot')
$('sim-save').addEventListener('click', () => sim.send({ type: 'save', slot: Number(slotEl.value) }))
$('sim-load').addEventListener('click', () => sim.send({ type: 'load', slot: Number(slotEl.value) }))
$('sim-back1').addEventListener('click', () => sim.send({ type: 'rewind', seconds: 1 }))
$('sim-back5').addEventListener('click', () => sim.send({ type: 'rewind', seconds: 5 }))
// click on the timeline: go back to that moment (the sim cannot skip ahead of what it has simulated)
$('timeline').addEventListener('click', (e) => {
  if (!sim.active || !sim.latest) return
  if (robotMode) { $('notice').textContent = 'Rewinding needs the scripted robot: the robot program cannot be taken back'; return }
  const t = timeline.timeAt(e.clientX)
  if (t === null) return
  if (t > sim.latest.time + 0.05) { $('notice').textContent = 'The sim cannot skip ahead: click a moment that has already been simulated'; return }
  sim.send({ type: 'seek', time: t })
})

/** Sends the gamepad or keyboard state to the robot when it changes (and at least every 250 ms while held). */
function pumpInput(): void {
  const now = performance.now()
  const r = readInput()
  if (sameReading(lastInput, r) && now - lastInputSent < 250) return
  if (sameReading(lastInput, r) && r.source === 'none') return
  lastInput = r
  lastInputSent = now
  sim.send({ type: 'joystick', axes: r.axes, buttons: r.buttons, pov: r.pov })
}

const simPanel = new SimPanel($('simhud'))

// ---- match analysis: the recorder sees every frame; the Analysis tab, the timeline and the match summary are drawn from it
const recorder = new MatchRecorder()
const analysisView = new AnalysisView(recorder)
const timeline = new TimelineBar($('timeline'))
let endShown = false
let lastStart = { seed: 42, game: '', mode: '' }
let ownAlliance: 'blue' | 'red' = 'blue'
sim.onFrame = (f, events) => {
  recorder.ingest(f, events)
  if (sim.bridge) mechHistory.add(f.time, sim.bridge.mechanisms)
  fx.sampleTrail(f)
  if (recorder.phase === 'ended') {
    if (!endShown) { endShown = true; showMatchSummary() }
  } else endShown = false
}
function showMatchSummary(): void {
  if (!$<HTMLInputElement>('an-popup').checked) return
  renderSummary($('ms-body'), recorder.summary())
  const dlg = $<HTMLDialogElement>('match-summary')
  if (!dlg.open) dlg.showModal()
}
const saver = (window as unknown as { crucibleHost?: Saver }).crucibleHost
async function saveText(name: string, text: string, mime: string): Promise<void> {
  const where = await saveBlob(name, new Blob([text], { type: mime }), saver)
  $('notice').textContent = where ? `Saved ${where}` : 'Save cancelled'
}
const tune = new TuneUI({ live: (p) => { if (sim.active) sim.send({ type: 'tune', params: p }) }, notify: (t) => { $('notice').textContent = t }, saveText })
async function saveReport(): Promise<void> {
  const f = sim.ready?.field
  const html = reportHtml(recorder, { title: 'BALTA Crucible match report', game: lastStart.game, mode: lastStart.mode, seed: lastStart.seed, version: appVersion(), date: new Date().toISOString().slice(0, 16).replace('T', ' ') }, f?.length ?? 16.541, f?.width ?? 8.069)
  await saveText(timestampName('balta-crucible-report', 'html'), html, 'text/html')
}
$('an-report').addEventListener('click', () => { void saveReport() })
$('ms-save').addEventListener('click', () => { void saveReport() })
// save the run / the recorded topics, and compare runs
function currentRun(): RunReport {
  return recorder.toRunReport({ name: `${lastStart.game || 'run'} seed ${lastStart.seed}`, game: lastStart.game, seed: lastStart.seed, step: Number($<HTMLSelectElement>('step-dt').value) || 0.002 })
}
$('an-run').addEventListener('click', () => { void saveText(timestampName('balta-crucible-run', 'json'), JSON.stringify(currentRun(), null, 1), 'application/json') })
$('an-log').addEventListener('click', async () => {
  if (store.series.size === 0) { $('notice').textContent = 'Nothing recorded yet: start a sim first'; return }
  const where = await saveBlob(timestampName('balta-crucible-sim', 'wpilog'), new Blob([storeToWpilog(store).slice().buffer as ArrayBuffer], { type: 'application/octet-stream' }), saver)
  $('notice').textContent = where ? `Saved ${where}` : 'Save cancelled'
})
// seed sweep
const sweep = new SweepRunner()
$('sw-run').addEventListener('click', () => {
  if (sweep.running) { sweep.cancel(); $('sw-prog').textContent = 'Stopping after the current run…'; return }
  const n = Math.min(100, Math.max(1, Math.round(Number($<HTMLInputElement>('sw-n').value) || 10)))
  const secs = Math.min(300, Math.max(1, Number($<HTMLInputElement>('sw-t').value) || 30))
  const first = seedValue()
  const t0 = performance.now()
  $('sw-out').textContent = ''
  $('sw-run').textContent = 'Stop sweep'
  sweep.start({
    game: $<HTMLSelectElement>('game-select').value as 'test' | 'rebuilt', alliance: $<HTMLSelectElement>('alliance').value === 'red' ? 'red' : 'blue',
    opponent: $<HTMLSelectElement>('opponent').value as 'none' | 'blocker' | 'cycler' | 'ally' | 'both', start: startOverrides(), stepDt: Number($<HTMLSelectElement>('step-dt').value) || 0.002,
    seeds: Array.from({ length: n }, (_, i) => (first + i) >>> 0), duration: secs, tune: tune.params(),
  }, (st) => {
    renderSweep($('sw-out'), st.runs)
    const eta = st.runs.length > 0 && !st.done ? ` · about ${Math.ceil(((performance.now() - t0) / st.runs.length) * (st.total - st.runs.length) / 1000)} s left` : ''
    $('sw-prog').textContent = st.error ? `Sweep failed: ${st.error}` : st.done ? `${st.cancelled ? 'Stopped' : 'Done'}: ${st.runs.length} of ${st.total} runs in ${((performance.now() - t0) / 1000).toFixed(1)} s` : `Run ${st.runs.length} of ${st.total}…${eta}`
    if (st.done) $('sw-run').textContent = 'Run sweep'
  })
  $('sw-prog').textContent = `Run 0 of ${n}…`
})

let cmpA: RunReport | null = null
let cmpB: RunReport | null = null
let cmpTarget: 'a' | 'b' = 'a'
const cmpFile = $<HTMLInputElement>('cmp-file')
function paintCompare(): void { renderCompare($('cmp-body'), cmpA, cmpB, sim.ready?.field) }
for (const side of ['a', 'b'] as const) {
  $(`cmp-${side}`).addEventListener('click', () => { cmpTarget = side; cmpFile.value = ''; cmpFile.click() })
  $(`cmp-${side}-cur`).addEventListener('click', () => { if (side === 'a') cmpA = currentRun(); else cmpB = currentRun(); paintCompare() })
}
cmpFile.addEventListener('change', async () => {
  const f = cmpFile.files?.[0]
  if (!f) return
  const r = parseRunReport(await f.text())
  if (!r.ok) { $('notice').textContent = `${f.name}: ${r.error}`; return }
  if (r.report.name === 'run' || r.report.name === '') r.report.name = f.name
  if (cmpTarget === 'a') cmpA = r.report; else cmpB = r.report
  paintCompare()
})
paintCompare()
$('an-csv').addEventListener('click', () => { void saveText(timestampName('balta-crucible-events', 'csv'), eventsCsv(recorder.feed), 'text/csv') })
for (const id of ['an-k-score', 'an-k-foul', 'an-k-shot', 'an-k-pickup', 'an-k-impact', 'an-k-phase']) $(id).addEventListener('change', () => analysisView.render())
function simFrame(): void {
  if (robotMode) pumpInput()
  playEl.textContent = sim.running ? 'Pause' : 'Play'
  $<HTMLButtonElement>('sim-load').disabled = !sim.slots[Number(slotEl.value)]
  for (const [id, sec] of [['sim-back1', 1], ['sim-back5', 5]] as const) $<HTMLButtonElement>(id).disabled = robotMode || sim.canRewind < Math.min(sec, 0.25)
  $('timeline').classList.toggle('seekable', !robotMode)
  const f = sim.latest
  if (!f) return
  time = f.time
  $('time').textContent = `sim ${f.time.toFixed(2)} s`
  simPanel.update(buildSimModel(f, { running: sim.running, simRate: sim.simRate, bridge: sim.bridge, hubs: sim.ready?.field.sensors.map((x) => ({ x: x.center[0], y: x.center[1], alliance: x.alliance })), alliance: ownAlliance }))
  if ($('simhud').hidden) $('simhud').hidden = false
  plot.build(store)
}

// ---- frame loop
let lastList = 0
let lastAnalysis = 0
let lastInspect = 0
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000)
  lastFrame = now

  if (sim.active) {
    simFrame()
  } else if (store.mode === 'log') {
    if (playing) {
      time += dt * speed
      if (time >= store.tMax) { time = store.tMax; playing = false; playEl.textContent = 'Play' }
    }
    if (!seeking) seekEl.value = String(store.tMax > store.tMin ? (time - store.tMin) / (store.tMax - store.tMin) : 0)
    $('time').textContent = `${(time - store.tMin).toFixed(2)} / ${(store.tMax - store.tMin).toFixed(2)} s`
  } else if (store.mode === 'live') {
    time = store.tMax
    $('time').textContent = `live ${time.toFixed(2)} s`
    plot.build(store)
  } else {
    $('time').textContent = '0.00 / 0.00 s'
  }

  // scene
  if (sim.active) {
    if (sim.latest) { view.setSimFrame(sim.latest, robotHalfZ); fx.update(sim.latest, recorder); paintScoreboard(sim.latest) }
    view.setComponentPoses(sim.bridge?.components ?? undefined)
  } else {
    const pose = poseSel.value ? store.valueAt(poseSel.value, time) : undefined
    if (pose instanceof Float64Array) {
      if (store.series.get(poseSel.value)!.type === 'struct:Pose3d') view.setRobotPose3d(pose)
      else view.setRobotPose2d(pose)
    }
    const comps = compSel.value ? store.valueAt(compSel.value, time) : undefined
    view.setComponentPoses(comps instanceof Float64Array ? comps : undefined)
  }
  view.render()
  plot.setCursor(time)

  // timeline bar while a sim runs; the Analysis tab redraws a few times a second while it is open
  const tl = $('timeline')
  const showTl = sim.active && !!sim.ready && !!sim.latest
  if (tl.hidden === showTl) tl.hidden = !showTl
  if (showTl) timeline.update(sim.ready!.phases, recorder, sim.latest!.time)
  if (now - lastAnalysis > 250 && !$('tab-analysis').hidden) { lastAnalysis = now; analysisView.render() }
  if (now - lastInspect > 200 && !$('tab-robot').hidden) { lastInspect = now; if (sim.active && sim.bridge) inspector.update(mechHistory) }

  // topic values at 5 Hz
  if (now - lastList > 200) {
    lastList = now
    for (const [name, r] of rowByName) r.val.textContent = summarize(store.valueAt(name, time))
  }
  requestAnimationFrame(frame)
}

store.onTopicsChanged(() => {
  // live sources announce topics one by one: rebuild the list at most 4 times per second
  scheduleListRefresh()
})
let listTimer: ReturnType<typeof setTimeout> | null = null
function scheduleListRefresh(): void {
  if (listTimer) return
  listTimer = setTimeout(() => { listTimer = null; renderTopicList() }, 250)
}

// ---- robot testing: battery model, faults, mechanism inspector; breakpoints
const mechHistory = new MechHistory()
const inspector = new MechInspector($('mech-inspector'))
const numOf = (id: string, d: number): number => { const v = Number($<HTMLInputElement>(id).value.trim().replace(',', '.')); return Number.isFinite(v) ? v : d }
function batterySpec(): { enabled: boolean; openVolts: number; resistance: number } {
  return { enabled: $<HTMLInputElement>('bat-on').checked, openVolts: numOf('bat-open', 12.6), resistance: numOf('bat-res', 18) / 1000 }
}
function faultsSpec(): { brownoutVolts: number | null; latencyMs: number; noise: number; dropIds: number[] } {
  const ids = $<HTMLInputElement>('f-drop').value.split(/[\s,;]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n))
  return { brownoutVolts: $<HTMLInputElement>('f-brown-on').checked ? numOf('f-brown', 6.8) : null, latencyMs: numOf('f-lat', 0), noise: numOf('f-noise', 0), dropIds: ids }
}
function paintFaultNote(): void {
  const f = faultsSpec(), b = batterySpec()
  const parts = [b.enabled ? `battery ${b.openVolts} V, ${(b.resistance * 1000).toFixed(0)} mΩ` : '', f.brownoutVolts !== null ? `brownout ${f.brownoutVolts} V` : '', f.latencyMs > 0 ? `latency ${f.latencyMs} ms` : '', f.noise > 0 ? `noise ${f.noise}` : '', f.dropIds.length ? `CAN ${f.dropIds.join(', ')} dropped` : ''].filter(Boolean)
  $('f-note').textContent = parts.length ? `Active: ${parts.join(' · ')}. Robot-code modes only.` : 'Nothing injected. Robot-code modes only.'
}
for (const id of ['bat-on', 'bat-open', 'bat-res']) $(id).addEventListener('change', () => { if (sim.active) sim.send({ type: 'battery', battery: batterySpec() }); paintFaultNote() })
for (const id of ['f-brown-on', 'f-brown', 'f-lat', 'f-noise', 'f-drop']) $(id).addEventListener('input', () => { if (sim.active) sim.send({ type: 'faults', faults: faultsSpec() }); paintFaultNote() })
$('f-brown-on').addEventListener('change', () => { if (sim.active) sim.send({ type: 'faults', faults: faultsSpec() }); paintFaultNote() })

function breakSpec(): { launch: boolean; capture: boolean; score: boolean; foul: boolean; phase: boolean; impact: number | null; time: number | null } {
  const on = (id: string): boolean => $<HTMLInputElement>(id).checked
  return { launch: on('bp-launch'), capture: on('bp-capture'), score: on('bp-score'), foul: on('bp-foul'), phase: on('bp-phase'), impact: on('bp-impact-on') ? numOf('bp-impact', 2) : null, time: on('bp-time-on') ? numOf('bp-time', 10) : null }
}
for (const id of ['bp-launch', 'bp-capture', 'bp-score', 'bp-foul', 'bp-phase', 'bp-impact-on', 'bp-impact', 'bp-time-on', 'bp-time']) $(id).addEventListener('change', () => { if (sim.active) sim.send({ type: 'breaks', breaks: breakSpec() }) })
sim.onPaused = (reason, t) => {
  $('notice').textContent = `Paused: ${reason} at ${t.toFixed(2)} s`
  $('bp-last').textContent = `Paused at ${t.toFixed(2)} s: ${reason}`
}

// ---- start position / alliance, view menu, camera, ruler, scoreboard
function startOverrides(): { x?: number; y?: number; yawDeg?: number } | undefined {
  const num = (id: string): number | undefined => { const v = $<HTMLInputElement>(id).value.trim().replace(',', '.'); const n = v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : undefined }
  const o = { x: num('start-x'), y: num('start-y'), yawDeg: num('start-yaw') }
  return o.x === undefined && o.y === undefined && o.yawDeg === undefined ? undefined : o
}

const camSel = $<HTMLSelectElement>('camera-select')
for (const c of CAMERA_PRESETS) camSel.append(new Option(c.label, c.id))
camSel.addEventListener('change', () => { fx.setPreset(camSel.value as CameraPreset); camSel.blur() })
const viewMenu = $('view-menu')
$('view-btn').addEventListener('click', () => { viewMenu.hidden = !viewMenu.hidden; $('view-btn').setAttribute('aria-expanded', String(!viewMenu.hidden)) })
document.addEventListener('pointerdown', (e) => {
  if (!viewMenu.hidden && !(e.target as HTMLElement).closest('#view-menu, #view-btn')) { viewMenu.hidden = true; $('view-btn').setAttribute('aria-expanded', 'false') }
})
const vm = (id: string): boolean => $<HTMLInputElement>(id).checked
function applyViewMenu(): void {
  view.setOverlays({ boxes: vm('vm-boxes'), capture: vm('vm-capture'), sensors: vm('vm-sensors') })
  fx.show.rules = vm('vm-rules'); fx.show.trail = vm('vm-trail'); fx.show.arcs = vm('vm-arcs'); fx.apply()
  view.setRobotCam(vm('vm-cam') && sim.active ? ($<HTMLSelectElement>('vm-cammode').value as 'front' | 'top') : null)
  $('cam-label').hidden = !(vm('vm-cam') && sim.active)
  $('cam-label').textContent = $<HTMLSelectElement>('vm-cammode').value === 'top' ? 'robot camera: top-down' : 'robot camera: front'
  $('scoreboard').hidden = !(vm('vm-score') && sim.active)
}
for (const id of ['vm-boxes', 'vm-capture', 'vm-sensors', 'vm-rules', 'vm-trail', 'vm-arcs', 'vm-cam', 'vm-cammode', 'vm-score']) $(id).addEventListener('change', applyViewMenu)
$('ruler-btn').addEventListener('click', () => { fx.setRuler(!fx.rulerActive); $('ruler-btn').classList.toggle('on', fx.rulerActive); $('ruler-btn').textContent = fx.rulerActive ? 'Ruler on' : 'Ruler' })
function paintScoreboard(f: RenderFrame): void {
  if ($('scoreboard').hidden || !sim.ready) return
  const m = scoreboardModel(f, sim.ready.phases)
  setIfChanged($('sb-blue'), String(m.blue)); setIfChanged($('sb-red'), String(m.red)); setIfChanged($('sb-clock'), m.clock); setIfChanged($('sb-phase'), m.phase)
  const hubs = $('sb-hubs')
  const html = m.hubs ? `<span class="sb-hub blue ${m.hubs.blue}">HUB</span><span class="sb-hub red ${m.hubs.red}">HUB</span>` : ''
  if (hubs.dataset.k !== html) { hubs.dataset.k = html; hubs.innerHTML = html }
}

// ---- Robot tab: mode, NT host, the robot launcher and its log (the launcher is Electron only: the main process owns the robot process)
interface PreflightCheck { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string }
interface StartResult { ok: boolean; message: string; checks?: PreflightCheck[]; envProblems?: string[]; logName?: string }
interface CrucibleHost {
  startRobot(lockstep?: boolean, envText?: string): Promise<StartResult>
  stopRobot(): Promise<{ ok: boolean }>
  robotStatus(): Promise<{ running: boolean }>
  onRobotLog(cb: (line: string) => void): void
  onRobotExit(cb: (code: number | null) => void): void
  checkRobot(lockstep?: boolean): Promise<PreflightCheck[]>
  getRobotDir(): Promise<{ dir: string | null; recent: string[] }>
  setRobotDir(dir: string): Promise<{ ok: boolean; dir?: string; error?: string }>
  pickRobotDir(): Promise<{ ok: boolean; dir?: string; error?: string; canceled?: boolean }>
  openSource(file: string, line: number): Promise<{ ok: boolean; message: string }>
  listLogs(): Promise<{ name: string; size: number; mtime: number }[]>
  readLog(name: string): Promise<string | null>
}
const robotLog = new LogView($('robot-log'), {
  count: $('log-count'), filter: $<HTMLInputElement>('log-filter'), follow: $<HTMLInputElement>('log-follow'),
  copy: $<HTMLButtonElement>('log-copy'), save: $<HTMLButtonElement>('log-save'), clear: $<HTMLButtonElement>('log-clear'),
  levels: { error: $<HTMLInputElement>('lv-error'), warn: $<HTMLInputElement>('lv-warn'), info: $<HTMLInputElement>('lv-info') },
  errCount: $('err-count'), errPrev: $<HTMLButtonElement>('err-prev'), errNext: $<HTMLButtonElement>('err-next'),
  sources: $('log-src'),
}, (t) => { $('notice').textContent = t })

// one NT host: the Data card (Connect) and the Robot tab edit the same value
const hostEls = [$<HTMLInputElement>('host'), $<HTMLInputElement>('robot-host')]
for (const el of hostEls) {
  el.addEventListener('input', () => {
    // the other box follows, and tells its own listeners (so the remembered value is saved whichever box was edited)
    for (const o of hostEls) if (o !== el && o.value !== el.value) { o.value = el.value; o.dispatchEvent(new Event('input')) }
  })
}

const modeEl = $<HTMLSelectElement>('sim-mode')
const modeNames: Record<string, string> = { script: 'scripted robot', robot: 'robot code (real time)', lockstep: 'robot code (lockstep, Mode B)' }
const modeHint = $('sim-mode-hint')
const robotState = $('robot-state')
const run = new RobotRun()
let robotUp = false
let launchedLockstep = false
const exitWaiters: (() => void)[] = []
const tracker = new SourceTracker()
let historyHost: CrucibleHost | null = null // set when the desktop tools start
const host = (window as unknown as { crucibleHost?: CrucibleHost }).crucibleHost

/** The status line under the buttons: what the robot process is doing, how long, and a moving bar while it builds. */
function paintRun(): void {
  run.connected = sim.active && !!sim.bridge?.connected
  $('run-dot').className = `dot ${run.tone === 'dim' ? '' : run.tone}`
  setIfChanged($('run-phase'), run.label)
  setIfChanged($('run-time'), run.phase === 'idle' ? '' : formatElapsed(run.elapsed(Date.now())))
  $('run-bar').hidden = !(run.phase === 'starting' || run.phase === 'building')
}
function setIfChanged(el: HTMLElement, text: string): void { if (el.textContent !== text) el.textContent = text }
setInterval(paintRun, 250)

const refreshRobot = (): void => {
  modeHint.textContent = `Mode: ${modeNames[modeEl.value]} (set on the Robot tab)`
  modeHint.hidden = false
  const btn = $('launch-robot')
  btn.textContent = robotUp ? 'Stop robot' : 'Launch robot'
  $('relaunch-robot').hidden = !(host && robotUp)
  if (!host) robotState.textContent = 'Launching the robot needs the desktop app. Start the robot sim yourself with CRUCIBLE_BRIDGE=1 ./gradlew simulateJava.'
  else if (!robotUp) robotState.textContent = modeEl.value === 'script' ? 'Scripted robot needs no robot program.' : 'Robot program not running.'
  else if ((modeEl.value === 'lockstep') !== launchedLockstep) robotState.textContent = `Running in ${launchedLockstep ? 'lockstep' : 'real-time'} mode: stop and launch again to change the mode.`
  else robotState.textContent = `Robot program running (${launchedLockstep ? 'lockstep' : 'real time'}).`
  paintRun()
}
modeEl.addEventListener('change', refreshRobot)

let launching = false
async function launchRobot(): Promise<void> {
  if (!host || launching) return
  launching = true
  try { await launchRobotNow(host) } finally { launching = false }
}

async function launchRobotNow(host: CrucibleHost): Promise<void> {
  launchedLockstep = modeEl.value === 'lockstep'
  run.start(Date.now())
  paintRun()
  robotLog.system(`[launching robot sim, ${launchedLockstep ? 'lockstep (Mode B)' : 'real time'}: gradlew simulateJava --no-daemon]`)
  tracker.reset()
  const r = await host.startRobot(launchedLockstep, $<HTMLTextAreaElement>('robot-env').value)
  for (const c of r.checks ?? []) if (c.status !== 'ok') robotLog.system(`[check] ${c.status === 'warn' ? '! ' : '✗ '}${c.label}: ${c.detail}`)
  for (const p of r.envProblems ?? []) robotLog.system(`[env] ${p}`)
  robotLog.system(`[${r.message}]`)
  void refreshHistory()
  $('notice').textContent = r.message
  robotUp = r.ok
  if (!r.ok) run.launchFailed(Date.now())
  refreshRobot()
  // the sim waits for the robot program to connect, so it can be started right away
  if (r.ok && $<HTMLInputElement>('auto-sim').checked && modeEl.value !== 'script' && !sim.active) $('start-sim').click()
}

async function stopRobot(): Promise<void> {
  if (!host) return
  run.stop()
  robotLog.system('[stopping robot sim]')
  await host.stopRobot()
  robotUp = false
  refreshRobot()
}

if (host) {
  $('launch-robot').hidden = false
  host.onRobotLog((line) => { robotLog.add(line, undefined, tracker.next(line)); run.feed(line) })
  host.onRobotExit((code) => {
    robotUp = false
    run.exit(code, Date.now())
    robotLog.system(`[robot sim exited with code ${code}]`)
    $('notice').textContent = `robot sim exited (${code})`
    void refreshHistory()
    refreshRobot()
    for (const w of exitWaiters.splice(0)) w()
  })
  $('launch-robot').addEventListener('click', () => { void (robotUp ? stopRobot() : launchRobot()) })
  $('relaunch-robot').addEventListener('click', async () => {
    if (robotUp) {
      // wait for the old process's exit report, or it would end the new run
      const exited = new Promise<void>((res) => { exitWaiters.push(res); setTimeout(res, 6000) })
      await stopRobot()
      await exited
    }
    await launchRobot()
  })
  void host.robotStatus().then((st) => { robotUp = st.running; if (st.running) { run.start(Date.now()); run.feed('> Task :simulateJava') } refreshRobot() })
  setupDesktopRobotTools(host)
} else {
  robotLog.system('[desktop app only: the robot sim is not started from here in a browser]')
  $('robot-desktop').hidden = true
}

/** The last three folders of a path, with … in front when something was cut (the full path is in the tooltip). */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p
}

/** Project folder, project check, extra environment, clickable source references and the past-runs list: all need the desktop app. */
function setupDesktopRobotTools(h: CrucibleHost): void {
  const dirEl = $('robot-dir')
  const recent = $<HTMLSelectElement>('recent-dirs')
  async function refreshDir(): Promise<void> {
    const { dir, recent: rec } = await h.getRobotDir()
    dirEl.textContent = dir ? shortPath(dir) : 'not set: choose the robot project folder'
    dirEl.title = dir ?? ''
    dirEl.classList.toggle('set', dir !== null)
    recent.textContent = ''
    recent.append(new Option('Recent projects…', ''))
    for (const d of rec) recent.append(new Option(d, d))
    recent.hidden = rec.length < 2
  }
  $('pick-dir').addEventListener('click', async () => {
    const r = await h.pickRobotDir()
    if (r.canceled) return
    $('notice').textContent = r.ok ? `Robot project: ${r.dir}` : (r.error ?? 'could not use that folder')
    if (!r.ok) robotLog.system(`[project] ${r.error}`)
    await refreshDir()
  })
  recent.addEventListener('change', async () => {
    if (recent.value === '') return
    const r = await h.setRobotDir(recent.value)
    $('notice').textContent = r.ok ? `Robot project: ${r.dir}` : (r.error ?? 'could not use that folder')
    await refreshDir()
  })
  const checksEl = $('checks')
  $('check-project').addEventListener('click', async () => {
    const list = await h.checkRobot(modeEl.value === 'lockstep')
    checksEl.textContent = ''
    for (const c of list) {
      const li = document.createElement('li')
      li.className = c.status
      const mk = document.createElement('span'); mk.className = 'mk'; mk.textContent = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'
      const body = document.createElement('span'); body.textContent = c.label
      const dt = document.createElement('span'); dt.className = 'dt'; dt.textContent = c.detail
      body.append(dt)
      li.append(mk, body)
      checksEl.append(li)
    }
    const bad = list.filter((c) => c.status !== 'ok').length
    const sum = $('checks-sum')
    sum.textContent = bad === 0 ? `✓ ${list.length} of ${list.length} checks passed` : `${list.length - bad} of ${list.length} checks passed · ${bad} to look at`
    sum.className = bad === 0 ? 'ok' : list.some((c) => c.status === 'fail') ? 'fail' : 'warn'
    const box = $<HTMLDetailsElement>('checks-box')
    box.hidden = false
    box.open = bad > 0 // everything fine: one line; something to fix: the list is open
  })
  robotLog.setSourceOpener((file, line) => { void h.openSource(file, line).then((r) => { $('notice').textContent = r.message }) })
  void refreshDir()
  historyHost = h
  void refreshHistory()
}

async function refreshHistory(): Promise<void> {
  const h = historyHost
  if (!h) return
  const list = await h.listLogs()
  const sel = $<HTMLSelectElement>('log-history')
  sel.textContent = ''
  sel.append(new Option('Past runs…', ''))
  for (const l of list) {
    const when = l.name.replace(/^robot-/, '').replace(/\.log$/, '').replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')
    sel.append(new Option(`${when} · ${(l.size / 1024).toFixed(l.size < 10240 ? 1 : 0)} KB`, l.name))
  }
  $('history-row').hidden = list.length === 0
}
$<HTMLSelectElement>('log-history').addEventListener('change', async (e) => {
  const sel = e.target as HTMLSelectElement
  const name = sel.value
  sel.value = ''
  if (!name || !historyHost) return
  const text = await historyHost.readLog(name)
  if (text === null) { $('notice').textContent = `Could not read ${name}`; return }
  robotLog.addHistory(name, text)
})

// remembered between runs: the choices in the side panels and the log's severity toggles
bindSettings(['bat-on', 'bat-open', 'bat-res', 'f-brown-on', 'f-brown', 'f-lat', 'f-noise', 'f-drop', 'bp-launch', 'bp-capture', 'bp-score', 'bp-foul', 'bp-phase', 'bp-impact-on', 'bp-impact', 'bp-time-on', 'bp-time', 'robot-env', 'vm-boxes', 'vm-capture', 'vm-sensors', 'vm-rules', 'vm-trail', 'vm-arcs', 'vm-cam', 'vm-cammode', 'vm-score', 'alliance', 'start-x', 'start-y', 'start-yaw', 'an-popup', 'an-k-score', 'an-k-foul', 'an-k-shot', 'an-k-pickup', 'an-k-impact', 'an-k-phase', 'game-select', 'sim-mode', 'opponent', 'step-dt', 'seed', 'host', 'robot-host', 'auto-sim', 'lv-error', 'lv-warn', 'lv-info'])
for (const el of hostEls) el.value = hostEls[0].value // restored values may differ if only one was saved
robotLog.syncLevels()
paintFaultNote()
applyViewMenu()
refreshRobot()

// ---- keyboard shortcuts (the table in lib/shortcuts.ts also fills the cheat sheet)
const shortcutsDialog = { open: () => {} }
const controls = setupControls((t) => { $('notice').textContent = t })
const actions: Record<string, () => void> = {
  play: togglePlay,
  step: () => { if (sim.active && !robotMode) $('sim-step').click() },
  'toggle-sim': () => $('start-sim').click(),
  reset: () => { if (sim.active) $('sim-reset').click() },
  'tab-session': () => showTab('session'),
  'tab-robot': () => showTab('robot'),
  'tab-topics': () => showTab('topics'),
  'tab-analysis': () => { showTab('analysis'); analysisView.render() },
  'tab-tune': () => showTab('tune'),
  panel: () => simPanel.toggle(),
  focus: () => view.focusRobot(),
  back1: () => { if (sim.active && !robotMode) $('sim-back1').click() },
  back5: () => { if (sim.active && !robotMode) $('sim-back5').click() },
  camera: () => { camSel.value = fx.cyclePreset(1) },
  'camera-prev': () => { camSel.value = fx.cyclePreset(-1) },
  ruler: () => { if (!$<HTMLButtonElement>('ruler-btn').disabled) $('ruler-btn').click() },
  scoreboard: () => { const c = $<HTMLInputElement>('vm-score'); c.checked = !c.checked; c.dispatchEvent(new Event('change')) },
  theme: () => $('theme-btn').click(),
  'log-clear': () => robotLog.clear(),
  'log-filter': () => { showTab('robot'); $('log-filter').focus() },
  'err-next': () => { showTab('robot'); robotLog.jumpError(1) },
  'err-prev': () => { showTab('robot'); robotLog.jumpError(-1) },
  help: () => shortcutsDialog.open(),
  controls: () => controls.open(),
}
window.addEventListener('keydown', (e) => {
  if (e.repeat || document.querySelector('dialog[open]')) return
  const name = keyName(e)
  const sc = findShortcut(name)
  if (!sc) return
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
  if (typing && !sc.key.includes('ctrl+')) return // plain keys belong to the field while typing; Ctrl combinations always work
  e.preventDefault()
  actions[sc.run]?.()
})

setupTabs()
shortcutsDialog.open = setupShortcutsDialog().open
setupTheme()
setupAbout()
setupCapture({ canvas: view.renderer.domElement, render: () => view.render(), notify: (t) => { $('notice').textContent = t }, host: (window as unknown as { crucibleHost?: { saveFile?: never } }).crucibleHost as never })
dismissSplash()
updateTransportEnabled()
renderTopicList()
view.loadRobotModel().then((msg) => { $('notice').textContent = msg }).catch((e) => { $('notice').textContent = `Model failed: ${(e as Error).message}` })
requestAnimationFrame(frame)

// exposed for debugging in the browser console and for automated checks
;(window as unknown as Record<string, unknown>).crucible = { store, view, plot, sim, openLogFile, seekTo, recorder, analysisView, fx, sweep, refStore, tune, mechHistory, readInput, get time() { return time } }
