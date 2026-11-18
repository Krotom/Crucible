// Score and timer burned into screenshots and videos: the 3D canvas is copied into a second canvas and a banner is drawn over it.
export interface OverlayFrame { time: number; phase: string; scores: { blue: number; red: number } }

/** The text of the banner for a frame, or null when there is no sim to describe. */
export function overlayLines(f: OverlayFrame | null | undefined): { left: string; mid: string; right: string } | null {
  if (!f) return null
  const m = Math.floor(f.time / 60), s = f.time - m * 60
  return { left: `BLUE ${f.scores.blue}`, mid: `${f.phase} ${m}:${s.toFixed(1).padStart(4, '0')}`, right: `${f.scores.red} RED` }
}

export function drawBanner(ctx: CanvasRenderingContext2D, w: number, lines: { left: string; mid: string; right: string }): void {
  const size = Math.max(14, Math.round(w / 48))
  ctx.save()
  ctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  const gap = size * 1.4
  const wl = ctx.measureText(lines.left).width, wm = ctx.measureText(lines.mid).width, wr = ctx.measureText(lines.right).width
  const total = wl + wm + wr + gap * 2
  const x0 = (w - total) / 2, h = size * 2, y = size * 0.6
  ctx.fillStyle = 'rgba(12, 14, 17, 0.78)'
  ctx.beginPath(); ctx.roundRect(x0 - gap * 0.6, y, total + gap * 1.2, h, size * 0.5); ctx.fill()
  const cy = y + h / 2
  ctx.fillStyle = '#6fb4ff'; ctx.fillText(lines.left, x0, cy)
  ctx.fillStyle = '#f2f2f2'; ctx.fillText(lines.mid, x0 + wl + gap, cy)
  ctx.fillStyle = '#ff7b7b'; ctx.fillText(lines.right, x0 + wl + gap * 2 + wm, cy)
  ctx.restore()
}

/** Copies the source canvas and the banner into `into` (sized to match). Call right after the source was rendered. */
export function composeInto(into: HTMLCanvasElement, src: HTMLCanvasElement, lines: { left: string; mid: string; right: string } | null): void {
  if (into.width !== src.width) into.width = src.width
  if (into.height !== src.height) into.height = src.height
  const ctx = into.getContext('2d')!
  ctx.drawImage(src, 0, 0)
  if (lines) drawBanner(ctx, into.width, lines)
}
