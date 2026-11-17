// Renderer only, in a normal browser (for quick checks without Electron): npm run web
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { modelServer } from './tools/model-plugin'

export default defineConfig({ root: resolve(__dirname, 'src/renderer'), server: { port: 5174 }, plugins: [modelServer()] })
