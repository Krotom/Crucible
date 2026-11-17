// Renderer only, in a normal browser (for quick checks without Electron): npm run web
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { modelServer } from './tools/model-plugin'

const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version

export default defineConfig({ root: resolve(__dirname, 'src/renderer'), server: { port: 5174 }, plugins: [modelServer()], define: { __APP_VERSION__: JSON.stringify(version) } })
