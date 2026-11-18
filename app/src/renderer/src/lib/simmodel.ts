// What the sim panel over the 3D view shows, as plain data (no DOM, so it can be tested): labeled rows in groups,
// with a short hint for each row that appears as a tooltip.
import type { BridgeInfo } from '../../../engine/protocol'
import type { RenderFrame } from '../../../engine/types'

export type Tone = 'ok' | 'warn' | 'bad' | 'dim'
export interface Row { id: string; label: string; value: string; tone?: Tone; hint?: string }
export interface Section { id: string; title: string; rows: Row[] }
export interface PanelModel {
  /** Header (always visible, also when the panel is collapsed). */
  phase: string
  clock: string
  blue: number
  red: number
  sections: Section[]
}

export interface SimInfo {
  running: boolean
  simRate: number
  bridge: BridgeInfo | null
  /** the scoring volumes of the field and the robot's alliance, for the distance to its HUB */
  hubs?: { x: number; y: number; alliance: string }[]
  alliance?: 'blue' | 'red'
}

const PHASE_NAMES: Record<string, string> = {
  none: 'No match', auto: 'Auto', delay: 'Delay', transition: 'Transition', teleop: 'Teleop',
  shift1: 'Shift 1', shift2: 'Shift 2', shift3: 'Shift 3', shift4: 'Shift 4', endgame: 'Endgame', ended: 'Match over',
}

/** Labels and hints for the values a game module reports (`GameModule.status`); a key the table does not know shows as it is. */
const STATUS_ROWS: Record<string, { label: string; hint: string }> = {
  hubs: { label: 'HUBs', hint: 'Which HUBs are scoring right now. FUEL put into an inactive HUB scores nothing.' },
  fuel: { label: 'FUEL scored', hint: 'FUEL scored per alliance, with the AUTO part in brackets (blue / red).' },
  gameData: { label: 'Game Data', hint: 'The character the robot receives: the alliance whose HUB goes inactive first (R or B).' },
  fouls: { label: 'Fouls', hint: 'G403: crossed the CENTER LINE in AUTO. G407: launched FUEL from outside your ALLIANCE ZONE.' },
}

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()
const squeeze = (s: string): string => s.replace(/\s{2,}/g, ' · ').replace(/ · \(/g, ' (')

export function phaseLabel(phase: string): string { return PHASE_NAMES[phase] ?? title(phase) }

export function buildSimModel(f: RenderFrame, info: SimInfo): PanelModel {
  const sections: Section[] = []

  sections.push({
    id: 'match', title: 'Match', rows: [
      { id: 'time', label: 'Sim time', value: `${f.time.toFixed(2)} s`, hint: 'Simulated seconds since the sim started or was reset' },
      { id: 'speed', label: 'Speed', value: info.running ? `${info.simRate.toFixed(2)}x real time` : 'Paused', tone: info.running ? undefined : 'warn', hint: 'How fast the simulation runs compared with the clock on the wall' },
    ],
  })

  const field: Row[] = [
    { id: 'pieces', label: 'FUEL on field', value: `${f.pieceCount} (${f.awakeCount} moving)`, hint: 'Game pieces in the world. Resting ones are frozen to keep the sim fast.' },
    { id: 'hits', label: 'Impacts', value: f.impacts.count > 0 ? `${f.impacts.count}, hardest ${f.impacts.peak.toFixed(2)} m/s` : 'none', tone: f.impacts.count > 0 ? 'warn' : 'dim', hint: 'Contacts the drive did not cause (walls, other robots) and the speed change of the hardest one' },
  ]
  const own = (info.hubs ?? []).filter((h) => h.alliance === (info.alliance ?? 'blue'))
  if (own.length > 0) {
    const d = Math.min(...own.map((h) => Math.hypot(f.robot[0] - h.x, f.robot[1] - h.y)))
    field.push({ id: 'hubdist', label: 'To your HUB', value: `${d.toFixed(2)} m`, hint: 'Straight-line distance from the robot to the nearest scoring volume of its alliance' })
  }
  sections.push({ id: 'field', title: 'Field', rows: field })

  const game = Object.entries(f.status).map(([k, v]): Row => {
    const known = STATUS_ROWS[k]
    return { id: k, label: known?.label ?? title(k), value: squeeze(v), tone: /INACTIVE/.test(v) ? 'warn' : undefined, hint: known?.hint }
  })
  if (game.length > 0) sections.push({ id: 'game', title: 'Game', rows: game })

  if (f.capture) {
    sections.push({
      id: 'robot', title: 'Robot', rows: [
        { id: 'held', label: 'Holding', value: `${f.held.length} FUEL`, hint: 'Game pieces inside the robot (intake, stages, shooter)' },
        { id: 'beams', label: 'Beam breaks', value: f.beams.map((b) => (b ? '●' : '○')).join(' ') || '-', hint: '● = blocked, ○ = clear: the sensors along the path from intake to shooter' },
        { id: 'intake', label: 'Intake', value: f.capture.active ? 'on' : 'off', tone: f.capture.active ? 'ok' : 'dim' },
        { id: 'caught', label: 'Caught', value: String(f.captured), hint: 'Pieces picked up so far' },
        { id: 'shots', label: 'Shots', value: String(f.shots), hint: 'Pieces launched so far' },
      ],
    })
  }

  const b = info.bridge
  if (b) {
    const link: Row[] = [
      { id: 'link', label: 'Robot program', value: b.connected ? 'connected' : 'waiting for it…', tone: b.connected ? 'ok' : 'warn', hint: 'Whether your robot code is connected to the simulation. Launch it from the Robot tab.' },
    ]
    if (b.frames > 0) {
      link.push(
        { id: 'enabled', label: 'Robot state', value: b.robotEnabled ? 'enabled' : 'disabled', tone: b.robotEnabled ? 'ok' : 'dim', hint: 'Driver Station state the robot sees' },
        { id: 'rtt', label: 'Round trip', value: `${b.rttMs.toFixed(1)} ms`, hint: 'Time for one exchange with the robot program' },
        { id: 'lead', label: 'Lead', value: `${b.leadMs.toFixed(1)} ms`, hint: 'How far the simulation runs ahead of the robot' },
        ...(b.battery ? [{ id: 'battery', label: 'Battery', value: `${b.battery.volts.toFixed(1)} V · ${b.battery.amps.toFixed(0)} A`, tone: (b.battery.volts < 7 ? 'bad' : b.battery.volts < 9 ? 'warn' : undefined) as Tone | undefined, hint: 'The battery voltage the robot code was told and the current the motors draw (turn the battery model on in the Robot tab to see it sag)' }] : []),
        { id: 'frames', label: 'Frames', value: String(b.frames) },
      )
    }
    b.helloIssues.forEach((issue, i) => link.push({ id: `issue${i}`, label: 'Problem', value: issue, tone: 'bad' }))
    sections.push({ id: 'link', title: 'Robot link', rows: link })
    if (b.mechanisms.length > 0) {
      sections.push({
        id: 'mech', title: 'Mechanisms', rows: b.mechanisms.map((m): Row => ({
          id: m.name, label: m.name, value: `${m.position.toFixed(3)} rot · ${m.velocity.toFixed(2)} rps`,
          hint: 'Position in rotations and speed in rotations per second',
        })),
      })
    }
  }

  sections.push({
    id: 'det', title: 'Determinism', rows: [
      { id: 'hash', label: 'State hash', value: f.hash, tone: 'dim', hint: 'Same seed and same inputs give the same hash at the same step. Compare two runs to see whether they repeated.' },
    ],
  })

  return { phase: phaseLabel(f.phase), clock: `${f.time.toFixed(1)} s`, blue: f.scores.blue, red: f.scores.red, sections }
}

export interface ScoreboardModel {
  blue: number
  red: number
  /** time left in the match, m:ss */
  clock: string
  phase: string
  /** which HUBs score right now, when the game reports it */
  hubs: { blue: 'active' | 'inactive'; red: 'active' | 'inactive' } | null
}

/** The big scoreboard overlay: scores, the match clock counting down, the phase and the HUB status. */
export function scoreboardModel(f: RenderFrame, phases: { name: string; duration: number }[]): ScoreboardModel {
  const total = phases.filter((p) => Number.isFinite(p.duration)).reduce((a, p) => a + p.duration, 0)
  const left = Math.max(0, total - f.time)
  const m = /blue (\w+).*?red (\w+)/i.exec(f.status.hubs ?? '')
  const st = (w: string): 'active' | 'inactive' => (/inactive/i.test(w) ? 'inactive' : 'active')
  return {
    blue: f.scores.blue, red: f.scores.red, phase: phaseLabel(f.phase),
    clock: `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`,
    hubs: m ? { blue: st(m[1]), red: st(m[2]) } : null,
  }
}
