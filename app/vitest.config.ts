import { defineConfig } from 'vitest/config'

// engine tests simulate seconds of physics; with many test files running at once the default 5 s is too tight
export default defineConfig({ test: { testTimeout: 30_000 } })
