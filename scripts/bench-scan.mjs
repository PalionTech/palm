#!/usr/bin/env node
// Scanner benchmark: writes the synthetic cursor/plugins-sized origin (~4k files, the tree
// test/index/scan-fs.test.ts checks for correctness) to a temp dir and reports how long
// scanOrigin takes over a few runs. Not a pass/fail check; compare numbers across changes.
//
//   node scripts/bench-scan.mjs [--plugins 100] [--runs 5]
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const plugins = arg('plugins', 100);
const runs = arg('runs', 5);

register();
const { scanOrigin } = await import('../src/index/scan.ts');
const { syntheticCounts, writeSyntheticOrigin } = await import('../test/support/synthetic.ts');

const tmp = await realpath(await mkdtemp(join(tmpdir(), 'palm-bench-scan-')));
try {
  const root = join(tmp, 'repo');
  const files = await writeSyntheticOrigin(root, plugins);
  const expected = syntheticCounts(plugins);
  const times = [];
  let entities = 0;
  for (let i = 0; i <= runs; i++) {
    const started = performance.now();
    const r = await scanOrigin(root, { alias: 'bench', type: 'local', path: root });
    const elapsed = performance.now() - started;
    entities = r.entities.length;
    if (i > 0) times.push(elapsed); // run 0 warms up the module and fs caches
  }
  const want = Object.values(expected).reduce((a, b) => a + b, 0);
  if (entities !== want) throw new Error(`expected ${want} entities, scanned ${entities}`);
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const fmt = (ms) => `${ms.toFixed(1)} ms`;
  console.log(`scanOrigin: ${files} files, ${entities} entities, ${runs} runs after 1 warm-up`);
  console.log(
    `  mean ${fmt(mean)}  min ${fmt(times[0])}  median ${fmt(times[times.length >> 1])}  max ${fmt(times.at(-1))}`,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
