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
  },
});
