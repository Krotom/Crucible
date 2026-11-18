// Stacking toasts: short messages that pile up in a corner and fade, instead of one status line that the next message overwrites.
// This file is the queue (no DOM, so it is testable); chrome.ts draws it.
export type ToastKind = 'info' | 'ok' | 'warn' | 'error'
export interface Toast { id: number; text: string; kind: ToastKind; /** how many times this same message arrived while it was still showing */ count: number; shownAt: number; ttl: number }

const TTL: Record<ToastKind, number> = { info: 4000, ok: 3500, warn: 6000, error: 9000 }

export class ToastQueue {
  private items: Toast[] = []
  private nextId = 1
  /** every message ever pushed, newest last (bounded), so nothing is lost when a toast fades */
  readonly history: { text: string; kind: ToastKind; at: number }[] = []

  constructor(private max = 4, private historyMax = 100) {}

  /** Adds a message. The same text while it is still showing only bumps its counter and restarts its timer. Returns the toast. */
  /** `ttl` overrides how long it shows (ms): a toast that asks the user to click needs longer than a note. */
  push(text: string, kind: ToastKind = 'info', now = Date.now(), ttl?: number): Toast | null {
    const t = text.trim()
    if (!t) return null
    this.history.push({ text: t, kind, at: now })
    if (this.history.length > this.historyMax) this.history.shift()
    this.expire(now)
    const same = this.items.find((x) => x.text === t && x.kind === kind)
    if (same) { same.count++; same.shownAt = now; if (ttl) same.ttl = ttl; return same }
    const toast: Toast = { id: this.nextId++, text: t, kind, count: 1, shownAt: now, ttl: ttl ?? TTL[kind] }
    this.items.push(toast)
    while (this.items.length > this.max) this.items.shift()
    return toast
  }

  expire(now = Date.now()): void { this.items = this.items.filter((t) => now - t.shownAt < t.ttl) }
  dismiss(id: number): void { this.items = this.items.filter((t) => t.id !== id) }
  clear(): void { this.items = [] }
  /** What is showing now, oldest first. */
  visible(now = Date.now()): Toast[] { this.expire(now); return [...this.items] }
}

/** A guess at the kind from the words, for the many old call sites that only have a sentence. */
export function kindOf(text: string): ToastKind {
  if (/\b(could not|cannot|can't|failed|error|not found|invalid)\b/i.test(text)) return 'error'
  if (/\b(paused|cancel|nothing|needs|stopped|no .* yet)\b/i.test(text)) return 'warn'
  if (/^(saved|copied|loaded|opened|done)\b/i.test(text)) return 'ok'
  return 'info'
}
