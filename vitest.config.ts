import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Every test must override PALM_HOME/HOME with a temp dir; this guards against accidents.
      PALM_HOME: '/nonexistent-palm-home-set-per-test',
    },
    // Temp HOME and harness dirs, isolated git config, tokens stripped, global fetch blocked.
    setupFiles: ['test/support/setup.ts'],
    // Builds dist/ once; CLI tests spawn `node dist/cli.js`.
    globalSetup: ['test/support/build-dist.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
      // Measured at the palm 0.2 integration (lines 94.03, statements 91.45, functions 92.56,
      // branches 83.49) minus 3, rounded down. CLI tests run dist/ in a subprocess, so src/commands
      // and src/cli.ts count only what the in-process tests reach.
      thresholds: { lines: 91, statements: 88, functions: 89, branches: 80 },
    },
  },
});
