import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Emit dist/cli.js (package.json "bin"), not cli.mjs.
  fixedExtension: false,
  clean: true,
  // No source maps: they would map to src/, which the package does not ship, and triple its size.
  sourcemap: false,
  dts: false,
  // tsdown marks the chunk executable (chmod 755) because it starts with a shebang.
  banner: { js: '#!/usr/bin/env node' },
  // Code splitting: every `await import()` in src becomes its own chunk next to cli.js, so
  // `palm --help` loads only commander, picocolors and the command registrations.
  outputOptions: { codeSplitting: true },
});
