// The Controls dialog: a live view of connected gamepads, remapping of their buttons and axes (with "Learn"), and rebinding of the keyboard driving keys.
import { getBindings, getPadMap, setBindings, setPadMap } from './input'
import { bind, codeLabel, DEFAULT_KEYS, DRIVE_ACTIONS, saveBindings, type DriveAction } from './keybinds'
import { cleanPadMap, DEFAULT_PADMAP, detectControl, PAD_AXES, PAD_BUTTONS, savePadMap, type PadAxisName, type PadButton, type PadMap } from './padmap'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const activePad = (): Gamepad | null => (navigator.getGamepads?.() ?? []).find((g) => g && g.connected) ?? null

export function setupControls(notify: (text: string) => void): { open: () => void } {
  const dlg = $<HTMLDialogElement>('controls')
  let timer: ReturnType<typeof setInterval> | null = null
  let rebinding: DriveAction | null = null
  let learning: { kind: 'button'; button: PadButton; base: number[] } | { kind: 'axis'; axis: PadAxisName; base: number[] } | null = null

  const keyKeys = (): void => {
    const box = $('key-map')
    box.textContent = ''
    for (const a of DRIVE_ACTIONS) {
      const row = el('div', 'kb-row')
      const chip = el('kbd', undefined, rebinding === a.id ? 'press a key…' : codeLabel(getBindings()[a.id]))
      chip.id = `kb-${a.id}`
      const btn = el('button', undefined, 'Rebind'); btn.id = `kb-btn-${a.id}`
      btn.addEventListener('click', () => { rebinding = a.id; $('key-msg').textContent = `Press the key for "${a.label}" (Esc cancels)`; keyKeys() })
      row.append(el('span', 'kb-label', a.label), el('span', 'dimtext', a.hint), chip, btn)
      box.appendChild(row)
    }
  }

  const apply = (m: PadMap): void => { setPadMap(m); savePadMap(m); padTable() }

  function padTable(): void {
    const box = $('pad-map')
    box.textContent = ''
    const m = getPadMap()
    const nBtn = Math.max(17, activePad()?.buttons.length ?? 0), nAx = Math.max(6, activePad()?.axes.length ?? 0)
    for (const b of PAD_BUTTONS) {
      const row = el('div', 'pm-row')
      const sel = el('select'); sel.id = `pm-b-${b}`
      for (let i = 0; i < nBtn; i++) sel.append(new Option(`button ${i}`, String(i)))
      sel.value = String(m.buttons[b])
      sel.addEventListener('change', () => apply({ ...getPadMap(), buttons: { ...getPadMap().buttons, [b]: Number(sel.value) } }))
      const learn = el('button', undefined, learning?.kind === 'button' && learning.button === b ? 'press it…' : 'Learn'); learn.id = `pm-learn-b-${b}`
      learn.addEventListener('click', () => { const p = activePad(); if (!p) { $('pad-msg').textContent = 'No gamepad connected: press a button on it first'; return } learning = { kind: 'button', button: b, base: [...p.axes] }; $('pad-msg').textContent = `Press the button that should be ${b}`; padTable() })
      row.append(el('span', 'kb-label', b), sel, learn)
      box.appendChild(row)
    }
    for (const a of PAD_AXES) {
      const s = m.axes[a.id]
      const row = el('div', 'pm-row')
      const sel = el('select'); sel.id = `pm-a-${a.id}`
      for (let i = 0; i < nAx; i++) sel.append(new Option(`axis ${i}`, `axis:${i}`))
      for (let i = 0; i < nBtn; i++) sel.append(new Option(`button ${i} (analog)`, `button:${i}`))
      sel.value = `${s.kind}:${s.index}`
      const set = (patch: Partial<typeof s>): void => apply({ ...getPadMap(), axes: { ...getPadMap().axes, [a.id]: { ...getPadMap().axes[a.id], ...patch } } })
      sel.addEventListener('change', () => { const [kind, index] = sel.value.split(':'); set({ kind: kind as 'axis' | 'button', index: Number(index) }) })
      const inv = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.id = `pm-inv-${a.id}`; cb.checked = s.invert
      cb.addEventListener('change', () => set({ invert: cb.checked })); inv.append(cb, document.createTextNode('invert'))
      const learn = el('button', undefined, learning?.kind === 'axis' && learning.axis === a.id ? 'move it…' : 'Learn'); learn.id = `pm-learn-a-${a.id}`
      learn.addEventListener('click', () => { const p = activePad(); if (!p) { $('pad-msg').textContent = 'No gamepad connected: press a button on it first'; return } learning = { kind: 'axis', axis: a.id, base: [...p.axes] }; $('pad-msg').textContent = `Move the stick (or pull the trigger) for ${a.label}`; padTable() })
      row.append(el('span', 'kb-label', a.label), sel, inv, learn)
      box.appendChild(row)
    }
    $<HTMLInputElement>('pm-dead').value = String(m.deadzone)
    $('pm-dead-val').textContent = m.deadzone.toFixed(2)
  }

  /** The live view, redrawn every 50 ms while the dialog is open; also where "Learn" listens. */
  function tick(): void {
    const live = $('pad-live')
    const p = activePad()
    if (!p) { if (live.dataset.pad !== 'none') { live.dataset.pad = 'none'; live.textContent = ''; live.appendChild(el('div', 'dimtext', 'No gamepad found. Connect one and press a button on it (browsers only show a pad after it was used).')) } return }
    if (live.dataset.pad !== p.id + p.axes.length + p.buttons.length) {
      live.dataset.pad = p.id + p.axes.length + p.buttons.length
      live.textContent = ''
      live.appendChild(el('div', 'pad-name', p.id))
      const axes = el('div', 'pad-axes')
      p.axes.forEach((_, i) => { const r = el('div', 'pad-axis'); r.append(el('span', undefined, `axis ${i}`), el('div', 'pad-bar')); (r.lastChild as HTMLElement).appendChild(el('i')); r.append(el('b')); axes.appendChild(r) })
      const btns = el('div', 'pad-buttons')
      p.buttons.forEach((_, i) => { const d = el('span', 'pad-dot', String(i)); d.dataset.i = String(i); btns.appendChild(d) })
      live.append(axes, btns)
    }
    live.querySelectorAll<HTMLElement>('.pad-axis').forEach((r, i) => {
      const v = p.axes[i] ?? 0
      ;(r.querySelector('i') as HTMLElement).style.cssText = `left:${50 + Math.min(0, v) * 50}%;width:${Math.abs(v) * 50}%`
      ;(r.querySelector('b') as HTMLElement).textContent = v.toFixed(2)
    })
    live.querySelectorAll<HTMLElement>('.pad-dot').forEach((d) => { const b = p.buttons[Number(d.dataset.i)]; d.classList.toggle('on', !!b && (b.pressed || b.value > 0.6)); d.style.opacity = String(0.35 + 0.65 * (b?.value ?? 0)) })
    if (learning) {
      const found = detectControl(p, learning.base)
      if (found && (learning.kind === 'axis' || found.kind === 'button')) {
        const m = getPadMap()
        if (learning.kind === 'button') { $('pad-msg').textContent = `${learning.button} is now button ${found.index}`; apply({ ...m, buttons: { ...m.buttons, [learning.button]: found.index } }) }
        else { $('pad-msg').textContent = `${learning.axis} is now ${found.kind} ${found.index}`; apply({ ...m, axes: { ...m.axes, [learning.axis]: { kind: found.kind, index: found.index, invert: m.axes[learning.axis].invert } } }) }
        learning = null
        padTable()
      }
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!dlg.open || !rebinding) return
    e.preventDefault(); e.stopPropagation()
    if (e.code === 'Escape') { rebinding = null; $('key-msg').textContent = ''; keyKeys(); return }
    const r = bind(getBindings(), rebinding, e.code)
    if (r.ok) { setBindings(r.bindings); saveBindings(r.bindings); $('key-msg').textContent = `${DRIVE_ACTIONS.find((x) => x.id === rebinding)!.label}: ${codeLabel(e.code)}`; rebinding = null }
    else $('key-msg').textContent = r.error
    keyKeys()
  }, true)

  $('keys-reset').addEventListener('click', () => { setBindings({ ...DEFAULT_KEYS }); saveBindings({ ...DEFAULT_KEYS }); rebinding = null; $('key-msg').textContent = 'Keys back to the defaults'; keyKeys() })
  $('pad-reset').addEventListener('click', () => { apply(cleanPadMap(null)); learning = null; $('pad-msg').textContent = 'Gamepad mapping back to the standard layout' })
  $<HTMLInputElement>('pm-dead').addEventListener('input', () => apply({ ...getPadMap(), deadzone: Number($<HTMLInputElement>('pm-dead').value) }))
  void DEFAULT_PADMAP

  const open = (): void => {
    if (dlg.open) return
    rebinding = null; learning = null
    $('key-msg').textContent = ''; $('pad-msg').textContent = ''
    keyKeys(); padTable(); $('pad-live').dataset.pad = ''
    dlg.showModal()
    tick(); timer = setInterval(tick, 50)
  }
  dlg.addEventListener('close', () => { if (timer) clearInterval(timer); timer = null; rebinding = null; learning = null })
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  $('controls-btn').addEventListener('click', open)
  window.addEventListener('gamepadconnected', (e) => notify(`Gamepad connected: ${(e as GamepadEvent).gamepad.id}`))
  window.addEventListener('gamepaddisconnected', () => notify('Gamepad disconnected'))
  return { open }
}
