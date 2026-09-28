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
      // Measured at wave 0 (lines/statements 80.25, functions 90.38, branches 86.89) minus 3.
      // Branches re-measured for vitest 4, whose v8 provider always uses AST-aware remapping:
      // 79.16 minus 3. vitest 3 with experimentalAstAwareRemapping reports the same 79.16, so
      // the drop from 90 is a change in how branches are counted, not lost coverage.
      // CLI tests run dist/ in a subprocess, so src/commands and src/cli.ts show low here.
      thresholds: { lines: 77, statements: 77, functions: 87, branches: 76 },
    },
  },
});
