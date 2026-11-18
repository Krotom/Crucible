// The command palette's matching: type a few letters of what you want ("rst", "dark", "tune") and the best commands come first.
export interface Command { id: string; label: string; /** the key hint shown at the right, if any */ hint?: string; group?: string }

/** Lower case with accents removed, so "turk" finds "Türkçe" and "istanbul" finds "İstanbul". */
export function fold(s: string): string { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i') }

/** Scores how well `query` matches `text` as a subsequence, or null when it does not match. Higher is better: runs of consecutive letters, word starts and early matches score more. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query).replace(/\s+/g, '')
  if (q === '') return 0
  const t = fold(text)
  let score = 0, ti = 0, run = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    const wordStart = at === 0 || /[\s\-/(]/.test(t[at - 1])
    run = at === ti && ti > 0 ? run + 1 : 0
    score += 1 + (wordStart ? 4 : 0) + run * 3 - Math.min(at - ti, 6) * 0.3
    ti = at + 1
  }
  if (t.startsWith(q)) score += 10
  else if (t.includes(q)) score += 6
  return score - t.length * 0.02
}

/** The commands that match, best first (ties keep the table's order); everything when the query is empty. */
export function rank(commands: Command[], query: string, limit = 12): Command[] {
  const scored: { c: Command; s: number; i: number }[] = []
  commands.forEach((c, i) => { const s = fuzzyScore(query, c.label + ' ' + (c.group ?? '')); if (s !== null) scored.push({ c, s, i }) })
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return scored.slice(0, limit).map((x) => x.c)
}
