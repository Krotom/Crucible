// Draws the installer bitmaps: node tools/build-installer-art.mjs src/renderer/assets/brand installer   (needs @napi-rs/canvas, installed in a scratch folder)
// Draws the installer's welcome and header bitmaps (24-bit BMP, which NSIS needs) from the brand images.
import fs from 'node:fs'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const [brandDir, outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

function bmp(canvas) {
  const w = canvas.width, h = canvas.height
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data
  const row = Math.ceil((w * 3) / 4) * 4
  const buf = Buffer.alloc(54 + row * h)
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, o = 54 + (h - 1 - y) * row + x * 3
    buf[o] = d[s + 2]; buf[o + 1] = d[s + 1]; buf[o + 2] = d[s]
  }
  return buf
}

const emblem = await loadImage(path.join(brandDir, 'emblem-dark.png'))
const word = await loadImage(path.join(brandDir, 'wordmark-light.png'))

// welcome / finish page: 164 x 314
{
  const c = createCanvas(164, 314), x = c.getContext('2d')
  x.fillStyle = '#0b0c0e'; x.fillRect(0, 0, 164, 314)
  const g = x.createLinearGradient(0, 0, 0, 314); g.addColorStop(0, 'rgba(203,142,0,0.18)'); g.addColorStop(0.55, 'rgba(203,142,0,0)')
  x.fillStyle = g; x.fillRect(0, 0, 164, 314)
  x.imageSmoothingQuality = 'high'
  const ew = 112, eh = ew * emblem.height / emblem.width
  x.drawImage(emblem, (164 - ew) / 2, 46, ew, eh)
  const ww = 118, wh = ww * word.height / word.width
  x.drawImage(word, (164 - ww) / 2, 46 + eh + 26, ww, wh)
  x.fillStyle = '#cb8e00'; x.font = 'bold 11px sans-serif'; x.textAlign = 'center'
  x.fillText('C R U C I B L E', 82, 46 + eh + 26 + wh + 24)
  x.fillStyle = '#cb8e00'; x.fillRect(0, 312, 164, 2)
  fs.writeFileSync(path.join(outDir, 'welcome.bmp'), bmp(c))
}
// header: 150 x 57
{
  const c = createCanvas(150, 57), x = c.getContext('2d')
  x.fillStyle = '#0b0c0e'; x.fillRect(0, 0, 150, 57)
  x.imageSmoothingQuality = 'high'
  const eh = 38, ew = eh * emblem.width / emblem.height
  x.drawImage(emblem, 10, 10, ew, eh)
  const ww = 70, wh = ww * word.height / word.width
  x.drawImage(word, 10 + ew + 10, 14, ww, wh)
  x.fillStyle = '#cb8e00'; x.font = 'bold 8px sans-serif'
  x.fillText('CRUCIBLE', 10 + ew + 11, 14 + wh + 12)
  x.fillRect(0, 55, 150, 2)
  fs.writeFileSync(path.join(outDir, 'header.bmp'), bmp(c))
}
console.log('bitmaps written')
