import './style.css'
import { Nt4Live, type NtStatus } from './lib/nt4'
import { PlotPanel } from './lib/plot'
import { installKeyboard, readInput, sameReading, type JoystickReading } from './lib/input'
import { SceneView } from './lib/scene'
import { SimSource } from './lib/simsource'
import { DataStore } from './lib/store'
import { isNumericType, type Value } from './lib/structs'
import { parseWpilog } from './lib/wpilog'
import { LogView } from './lib/robotlog'
import { SimPanel } from './lib/simpanel'
import { buildSimModel } from './lib/simmodel'
import { dismissSplash, setupAbout, setupCapture, setupTabs, setupTheme } from './lib/chrome'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const store = new DataStore()
const view = new SceneView($('view'))
let live: Nt4Live | null = null
let robotHalfZ = 0.12
let robotMode = false
let dsEnabled = false
let lastInput: JoystickReading | null = null
let lastInputSent = 0
const sim = new SimSource(
  store,
  (r) => { robotHalfZ = r.robotHalf[2]; view.setSimField(r.field, r.pieces, r.robotHalf, r.othersHalf); sim.send({ type: 'speed', value: speed }); sendDs() },
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
const plot = new PlotPanel($('plot'), (t) => seekTo(t), () => renderTopicList())
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
  fillSelect(poseSel, all.filter((s) => s.type === 'struct:Pose2d' || s.type === 'struct:Pose3d').map((s) => s.name), /\/RealOutputs\/Swerve\/Pose$|\/Swerve\/Pose$/)
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
  $('simhud').hidden = !isSim
}

function stopSim(): void {
  if (!sim.active) return
  sim.stop()
  view.clearSim()
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
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); togglePlay() }
})
$<HTMLSelectElement>('speed').addEventListener('change', (e) => {
  speed = Number((e.target as HTMLSelectElement).value)
  if (sim.active) sim.send({ type: 'speed', value: speed })
})
seekEl.addEventListener('pointerdown', () => { seeking = true })
seekEl.addEventListener('pointerup', () => { seeking = false })
seekEl.addEventListener('input', () => seekTo(store.tMin + Number(seekEl.value) * (store.tMax - store.tMin)))
$('clear-plot').addEventListener('click', () => plot.clear(store))
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
  sim.start(seedValue(), lockstepMode ? 'lockstep' : robotMode ? 'robot' : 'script', $<HTMLInputElement>('host').value.trim() || '127.0.0.1', $<HTMLSelectElement>('game-select').value as 'test' | 'rebuilt', $<HTMLSelectElement>('opponent').value as 'none' | 'blocker' | 'cycler', Number($<HTMLSelectElement>('step-dt').value))
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
$('sim-step').addEventListener('click', () => sim.send({ type: 'step', steps: 10 }))
$('sim-reset').addEventListener('click', () => sim.send({ type: 'reset', seed: seedValue() }))
$('sim-save').addEventListener('click', () => sim.send({ type: 'save' }))
$('sim-load').addEventListener('click', () => sim.send({ type: 'load' }))

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
function simFrame(): void {
  if (robotMode) pumpInput()
  playEl.textContent = sim.running ? 'Pause' : 'Play'
  $<HTMLButtonElement>('sim-load').disabled = !sim.hasSnapshot
  const f = sim.latest
  if (!f) return
  time = f.time
  $('time').textContent = `sim ${f.time.toFixed(2)} s`
  simPanel.update(buildSimModel(f, { running: sim.running, simRate: sim.simRate, bridge: sim.bridge }))
  plot.build(store)
}

// ---- frame loop
let lastList = 0
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
    if (sim.latest) view.setSimFrame(sim.latest, robotHalfZ)
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

// ---- Robot tab: mode, NT host, the robot launcher and its log (the launcher is Electron only: the main process owns the robot process)
interface CrucibleHost {
  startRobot(lockstep?: boolean): Promise<{ ok: boolean; message: string }>
  stopRobot(): Promise<{ ok: boolean }>
  robotStatus(): Promise<{ running: boolean }>
  onRobotLog(cb: (line: string) => void): void
  onRobotExit(cb: (code: number | null) => void): void
}
const robotLog = new LogView($('robot-log'), {
  count: $('log-count'), filter: $<HTMLInputElement>('log-filter'), follow: $<HTMLInputElement>('log-follow'),
  copy: $<HTMLButtonElement>('log-copy'), save: $<HTMLButtonElement>('log-save'), clear: $<HTMLButtonElement>('log-clear'),
}, (t) => { $('notice').textContent = t })

// one NT host: the Data card (Connect) and the Robot tab edit the same value
const hostEls = [$<HTMLInputElement>('host'), $<HTMLInputElement>('robot-host')]
for (const el of hostEls) el.addEventListener('input', () => { for (const o of hostEls) if (o !== el) o.value = el.value })

const modeEl = $<HTMLSelectElement>('sim-mode')
const modeNames: Record<string, string> = { script: 'scripted robot', robot: 'robot code (real time)', lockstep: 'robot code (lockstep, Mode B)' }
const modeHint = $('sim-mode-hint')
const robotState = $('robot-state')
let robotUp = false
let launchedLockstep = false
const host = (window as unknown as { crucibleHost?: CrucibleHost }).crucibleHost
const refreshRobot = (): void => {
  modeHint.textContent = `Mode: ${modeNames[modeEl.value]} (set on the Robot tab)`
  modeHint.hidden = false
  const btn = $('launch-robot')
  btn.textContent = robotUp ? 'Stop robot' : 'Launch robot'
  if (!host) robotState.textContent = 'Launching the robot needs the desktop app. Start the robot sim yourself with CRUCIBLE_BRIDGE=1 ./gradlew simulateJava.'
  else if (!robotUp) robotState.textContent = modeEl.value === 'script' ? 'Scripted robot needs no robot program.' : 'Robot program not running.'
  else if ((modeEl.value === 'lockstep') !== launchedLockstep) robotState.textContent = `Running in ${launchedLockstep ? 'lockstep' : 'real-time'} mode: stop and launch again to change the mode.`
  else robotState.textContent = `Robot program running (${launchedLockstep ? 'lockstep' : 'real time'}).`
}
modeEl.addEventListener('change', refreshRobot)
if (host) {
  const btn = $('launch-robot')
  btn.hidden = false
  host.onRobotLog((line) => robotLog.add(line))
  host.onRobotExit((code) => {
    robotUp = false
    robotLog.system(`[robot sim exited with code ${code}]`)
    $('notice').textContent = `robot sim exited (${code})`
    refreshRobot()
  })
  btn.addEventListener('click', async () => {
    if (robotUp) {
      robotLog.system('[stopping robot sim]')
      await host.stopRobot(); robotUp = false; refreshRobot(); return
    }
    launchedLockstep = modeEl.value === 'lockstep'
    robotLog.system(`[launching robot sim, ${launchedLockstep ? 'lockstep (Mode B)' : 'real time'}: gradlew simulateJava --no-daemon]`)
    const r = await host.startRobot(launchedLockstep)
    robotLog.system(`[${r.message}]`)
    $('notice').textContent = r.message
    robotUp = r.ok
    refreshRobot()
  })
  void host.robotStatus().then((s) => { robotUp = s.running; refreshRobot() })
} else robotLog.system('[desktop app only: the robot sim is not started from here in a browser]')
refreshRobot()

setupTabs()
setupTheme()
setupAbout()
setupCapture({ canvas: view.renderer.domElement, render: () => view.render(), notify: (t) => { $('notice').textContent = t }, host: (window as unknown as { crucibleHost?: { saveFile?: never } }).crucibleHost as never })
dismissSplash()
updateTransportEnabled()
renderTopicList()
view.loadRobotModel().then((msg) => { $('notice').textContent = msg }).catch((e) => { $('notice').textContent = `Model failed: ${(e as Error).message}` })
requestAnimationFrame(frame)

// exposed for debugging in the browser console and for automated checks
;(window as unknown as Record<string, unknown>).crucible = { store, view, plot, sim, openLogFile, seekTo, get time() { return time } }
