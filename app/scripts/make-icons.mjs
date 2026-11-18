// Makes the app icons (build/icon.png and build/icon.ico) when they are not there. The release builds start from a clean checkout, and build/ is not committed.
// Real icons win: commit your own app/build/icon.png and icon.ico (add them to the repository with `git add -f`) and this script leaves them alone.
// Otherwise the icons are made from the emblem in the brand assets with ImageMagick (`magick` or `convert`).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(app, 'build')
const png = path.join(outDir, 'icon.png'), ico = path.join(outDir, 'icon.ico')
const source = path.join(app, 'src', 'renderer', 'assets', 'brand', 'emblem.png')

if (fs.existsSync(png) && fs.existsSync(ico)) { console.log(`icons already there: ${outDir}`); process.exit(0) }
fs.mkdirSync(outDir, { recursive: true })
const tool = ['magick', 'convert'].find((t) => spawnSync(t, ['-version'], { stdio: 'ignore' }).status === 0)
if (!tool) { console.error('ImageMagick (magick or convert) is needed to make the icons, or put icon.png and icon.ico in app/build'); process.exit(1) }
const run = (args) => { const r = spawnSync(tool, args, { stdio: 'inherit' }); if (r.status !== 0) { console.error(`failed: ${tool} ${args.join(' ')}`); process.exit(r.status ?? 1) } }
// the emblem on a transparent square, with a margin
run([source, '-background', 'none', '-gravity', 'center', '-resize', '420x420', '-extent', '512x512', png])
run([png, '-define', 'icon:auto-resize=256,128,64,48,32,16', ico])
console.log(`made ${png} and ${ico} from the brand emblem`)
