// Builds the BALTA brand image assets from the logo PDF: transparent PNGs of the wordmark and emblem (light and dark variants) and the app icons.
import fs from 'node:fs'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const [pdfPath, outDir, buildDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(buildDir, { recursive: true })
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true }).promise

async function renderPage(n, scale) {
  const page = await doc.getPage(n)
  const v = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(v.width), Math.ceil(v.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: v, canvas }).promise
  return { canvas, ctx, w: canvas.width, h: canvas.height }
}

function bbox(img, y0, y1, thresh = 250) {
  const d = img.ctx.getImageData(0, 0, img.w, img.h).data
  let minX = img.w, minY = img.h, maxX = 0, maxY = 0
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4
    if (Math.min(d[i], d[i + 1], d[i + 2]) < thresh) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Crops a region and turns "ink on white" into transparency: alpha from the blue channel (gold and black both have none), colors un-premultiplied. */
function extract(img, box, pad, recolorDark) {
  const w = box.w + 2 * pad, h = box.h + 2 * pad
  const out = createCanvas(w, h)
  const octx = out.getContext('2d')
  const src = img.ctx.getImageData(box.x - pad, box.y - pad, w, h)
  const d = src.data
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.max(0, Math.min(1, 1 - d[i + 2] / 255))
    if (a < 0.004) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue }
    let r = (d[i] - (1 - a) * 255) / a, g = (d[i + 1] - (1 - a) * 255) / a, b = (d[i + 2] - (1 - a) * 255) / a
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b))
    if (recolorDark && r < 90 && g < 90 && b < 90) { r = 0xdc; g = 0xdc; b = 0xdc } // the ink becomes the brand's light gray
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = Math.round(a * 255)
  }
  octx.putImageData(src, 0, 0)
  return out
}

/** A mask-only image tinted one color (for the wordmark: black ink on white becomes `color` with the ink's alpha). */
function tinted(img, box, pad, color) {
  const w = box.w + 2 * pad, h = box.h + 2 * pad
  const out = createCanvas(w, h)
  const octx = out.getContext('2d')
  const src = img.ctx.getImageData(box.x - pad, box.y - pad, w, h)
  const d = src.data
  const [cr, cg, cb] = color
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] + d[i + 1] + d[i + 2]) / 3
    d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.round(Math.max(0, Math.min(1, 1 - lum / 255)) * 255)
  }
  octx.putImageData(src, 0, 0)
  return out
}

const save = (canvas, file) => { fs.writeFileSync(file, canvas.toBuffer('image/png')); console.log(file, canvas.width + 'x' + canvas.height) }
const scaleTo = (canvas, width) => { const h = Math.round((canvas.height * width) / canvas.width); const c = createCanvas(width, h); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, width, h); return c }

// ---- wordmark: page 9, the black one on white is the top half
const p9 = await renderPage(9, 4)
const wb = bbox(p9, 0, Math.floor(p9.h / 2))
save(scaleTo(tinted(p9, wb, 6, [1, 1, 1]), 1400), path.join(outDir, 'wordmark-ink.png'))
save(scaleTo(tinted(p9, wb, 6, [0xdc, 0xdc, 0xdc]), 1400), path.join(outDir, 'wordmark-light.png'))
save(scaleTo(tinted(p9, wb, 6, [0xcb, 0x8e, 0x00]), 1400), path.join(outDir, 'wordmark-gold.png'))

// ---- emblem: page 14 (gold blades, black handle and hexagon, the bee on the handle)
const p14 = await renderPage(14, 4)
const eb = bbox(p14, 0, p14.h)
const emblem = extract(p14, eb, 8, false)
const emblemDark = extract(p14, eb, 8, true)
save(scaleTo(emblem, 1024), path.join(outDir, 'emblem.png'))
save(scaleTo(emblemDark, 1024), path.join(outDir, 'emblem-dark.png'))

// ---- app icon: the emblem on a black rounded square
function icon(size) {
  const c = createCanvas(size, size)
  const x = c.getContext('2d')
  const r = size * 0.22
  x.fillStyle = '#010101'
  x.beginPath()
  x.moveTo(r, 0); x.arcTo(size, 0, size, size, r); x.arcTo(size, size, 0, size, r); x.arcTo(0, size, 0, 0, r); x.arcTo(0, 0, size, 0, r); x.closePath()
  x.fill()
  const target = size * 0.66
  const ratio = emblemDark.width / emblemDark.height
  const w = ratio >= 1 ? target : target * ratio
  const h = ratio >= 1 ? target / ratio : target
  x.imageSmoothingQuality = 'high'
  x.drawImage(emblemDark, (size - w) / 2, (size - h) / 2, w, h)
  return c
}
const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map((s) => icon(s).toBuffer('image/png'))
save(icon(512), path.join(buildDir, 'icon.png'))
save(icon(64), path.join(outDir, 'favicon.png'))
// .ico with PNG frames
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const dir = Buffer.concat(sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  return e
}))
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([head, dir, ...pngs]))
console.log('icon.ico', sizes.join(','))

// ---- small inline copies for generated reports (self-contained HTML)
const inl = (canvas, w) => scaleTo(canvas, w).toBuffer('image/png').toString('base64')
const wordInk = tinted(p9, wb, 6, [1, 1, 1])
const wordLight = tinted(p9, wb, 6, [0xdc, 0xdc, 0xdc])
fs.mkdirSync(path.join(path.dirname(buildDir), 'src/branding'), { recursive: true })
fs.writeFileSync(path.join(path.dirname(buildDir), 'src/branding/assets.ts'), [
  '// Generated from the BALTA Robotics logo file: small inline images for self-contained reports. Do not edit by hand.',
  `export const EMBLEM_LIGHT_B64 = '${inl(emblem, 160)}'`,
  `export const EMBLEM_DARK_B64 = '${inl(emblemDark, 160)}'`,
  `export const WORDMARK_INK_B64 = '${inl(wordInk, 420)}'`,
  `export const WORDMARK_LIGHT_B64 = '${inl(wordLight, 420)}'`,
  '',
].join('\n'))
console.log('src/branding/assets.ts')
