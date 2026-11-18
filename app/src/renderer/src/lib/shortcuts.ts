// Keyboard shortcuts: one table that both runs them and fills the cheat sheet, so the sheet cannot drift from what works.
// The driving keys (W A S D Q E J K L H) are never shortcuts: they belong to the robot.

export interface Shortcut {
  /** KeyboardEvent.key in lower case, with `ctrl+` in front when Ctrl (or Cmd) must be held. */
  key: string
  label: string
  group: 'Simulation' | 'View' | 'Log' | 'Help'
  run: string // the action name main.ts maps to a function
}

export const DRIVING_KEYS = ['w', 'a', 's', 'd', 'q', 'e', 'j', 'k', 'l', 'h']

export const SHORTCUTS: Shortcut[] = [
  { key: ' ', label: 'Play / pause', group: 'Simulation', run: 'play' },
  { key: '.', label: 'Step 10 ms (sim paused)', group: 'Simulation', run: 'step' },
  { key: 'ctrl+enter', label: 'Start / stop the sim', group: 'Simulation', run: 'toggle-sim' },
  { key: 'shift+r', label: 'Reset the sim', group: 'Simulation', run: 'reset' },
  { key: 'arrowleft', label: 'Back 1 s (scripted robot)', group: 'Simulation', run: 'back1' },
  { key: 'shift+arrowleft', label: 'Back 5 s (scripted robot)', group: 'Simulation', run: 'back5' },
  { key: '1', label: 'Session tab', group: 'View', run: 'tab-session' },
  { key: '2', label: 'Robot tab', group: 'View', run: 'tab-robot' },
  { key: '3', label: 'Topics tab', group: 'View', run: 'tab-topics' },
  { key: '4', label: 'Analysis tab', group: 'View', run: 'tab-analysis' },
  { key: '5', label: 'Tune tab', group: 'View', run: 'tab-tune' },
  { key: 'p', label: 'Fold / unfold the sim panel', group: 'View', run: 'panel' },
  { key: 'f', label: 'Focus the robot', group: 'View', run: 'focus' },
  { key: 'c', label: 'Next camera', group: 'View', run: 'camera' },
  { key: 'shift+c', label: 'Previous camera', group: 'View', run: 'camera-prev' },
  { key: 'm', label: 'Ruler: measure on the floor', group: 'View', run: 'ruler' },
  { key: 'b', label: 'Scoreboard overlay', group: 'View', run: 'scoreboard' },
  { key: 't', label: 'Switch dark / light theme', group: 'View', run: 'theme' },
  { key: 'ctrl+l', label: 'Clear the robot log', group: 'Log', run: 'log-clear' },
  { key: 'ctrl+f', label: 'Filter the robot log', group: 'Log', run: 'log-filter' },
  { key: 'n', label: 'Next error in the log', group: 'Log', run: 'err-next' },
  { key: 'shift+n', label: 'Previous error in the log', group: 'Log', run: 'err-prev' },
  { key: '?', label: 'Show this list', group: 'Help', run: 'help' },
]

/** Normalises a keydown to the table's notation, or null for keys that are only modifiers. */
export function keyName(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | null {
  if (e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'control' || k === 'shift' || k === 'meta' || k === 'alt') return null
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl) return `ctrl+${e.shiftKey ? 'shift+' : ''}${k}`
  if (e.shiftKey && ((k.length === 1 && /[a-z]/.test(k)) || k.startsWith('arrow'))) return `shift+${k}`
  return k
}

export function findShortcut(name: string | null): Shortcut | undefined {
  return name === null ? undefined : SHORTCUTS.find((s) => s.key === name)
}

/** Display form: "Ctrl+Shift+R", "Space", "?". */
export function keyLabel(key: string): string {
  return key.split('+').map((p) => (p === ' ' ? 'Space' : p === 'enter' ? 'Enter' : p === 'arrowleft' ? '←' : p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))).join('+')
}
