import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
    setupFiles: ['test/setup.ts'],
    // Coverage gate: thresholds are the 2026-10-18 baseline (statements 88.3, branches 80.0,
    // functions 88.3, lines 90.1) minus ~3 points, so the numbers can move without flaky failures.
    coverage: { thresholds: { statements: 85, branches: 77, functions: 85, lines: 87 } },
  },
})
