import { defineConfig } from 'vitest/config'

// engine tests simulate seconds of physics; with many test files running at once the default 5 s is too tight.
// The UI tests under e2e/ drive the real app and run separately (e2e/run.sh).
export default defineConfig({ test: { testTimeout: 30_000, exclude: ['node_modules/**', 'e2e/**', 'out/**'] } })
