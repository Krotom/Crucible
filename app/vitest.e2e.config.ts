import { defineConfig } from 'vitest/config'

// the UI tests that drive the real Electron app (run through e2e/run.sh, they need Electron and a display)
export default defineConfig({ test: { include: ['e2e/**/*.e2e.test.ts'], testTimeout: 600_000 } })
