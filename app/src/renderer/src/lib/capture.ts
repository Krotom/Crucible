// Screenshots and video of the 3D view. The screenshot renders and reads the canvas in the same tick (a WebGL canvas is blank to toBlob otherwise);
// the video is the canvas's own stream through a MediaRecorder (WebM). Files go through the main process's save dialog in the app and a plain
// download in a browser.
export interface Saver { saveFile?(name: string, data: ArrayBuffer, kind: 'png' | 'webm'): Promise<{ ok: boolean; path?: string }> }

export function timestampName(prefix: string, ext: string, d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`
}

/** Renders once and returns the canvas as a PNG. */
export function screenshot(canvas: HTMLCanvasElement, render: () => void): Promise<Blob> {
  render()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), 'image/png'))
}

export function pickMime(): string | null {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  return null
}

export class VideoRecorder {
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0

  get active(): boolean { return this.rec !== null && this.rec.state === 'recording' }
  get seconds(): number { return this.active ? (performance.now() - this.startedAt) / 1000 : 0 }

  start(canvas: HTMLCanvasElement, fps = 30, bitsPerSecond = 8_000_000): void {
    const mime = pickMime()
    if (!mime) throw new Error('this browser cannot record video')
    const stream = canvas.captureStream(fps)
    this.chunks = []
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond })
    this.rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data) }
    this.rec.start(500)
    this.startedAt = performance.now()
  }

  stop(): Promise<Blob> {
    const rec = this.rec
    if (!rec) return Promise.reject(new Error('not recording'))
    return new Promise((resolve) => {
      rec.onstop = () => { rec.stream.getTracks().forEach((t) => t.stop()); this.rec = null; resolve(new Blob(this.chunks, { type: 'video/webm' })) }
      rec.stop()
    })
  }
}

/** Saves a blob: through the app's save dialog when there is one, else as a download. Returns where it went (a path, or the file name for a download). */
export async function saveBlob(name: string, blob: Blob, host: Saver | undefined): Promise<string | null> {
  const kind = name.endsWith('.png') ? 'png' : 'webm'
  if (host?.saveFile) {
    const r = await host.saveFile(name, await blob.arrayBuffer(), kind)
    return r.ok ? r.path ?? name : null
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}
