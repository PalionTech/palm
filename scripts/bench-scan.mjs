#!/usr/bin/env node
// Scanner benchmark. Not a pass/fail check; compare numbers across changes.
//
//  1. the synthetic cursor/plugins-sized origin (~4k files at 100 plugins, the tree
//     test/index/scan-fs.test.ts checks for correctness), written to a temp dir;
//  2. the cursor/plugins-shaped fixture test/fixtures/cursor-monorepo-like (marketplace, Cursor
//     manifests, rules, hooks, MCP), many runs because it is small.
//
//   node scripts/bench-scan.mjs [--plugins 100] [--runs 5] [--fixture-runs 50]
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const plugins = arg('plugins', 100);
const runs = arg('runs', 5);
const fixtureRuns = arg('fixture-runs', 50);

register();
const { scanOrigin } = await import('../src/index/scan.ts');
const { syntheticCounts, writeSyntheticOrigin } = await import('../test/support/synthetic.ts');

const fmt = (ms) => `${ms.toFixed(1)} ms`;

/** Run `scan` once to warm up, then `n` timed times; print the summary; return the last result. */
async function bench(label, n, scan) {
  const times = [];
  let result;
  for (let i = 0; i <= n; i++) {
    const started = performance.now();
    result = await scan();
    if (i > 0) times.push(performance.now() - started); // run 0 warms up modules and fs caches
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${label}, ${n} runs after 1 warm-up`);
  console.log(
    `  mean ${fmt(mean)}  min ${fmt(times[0])}  median ${fmt(times[times.length >> 1])}  max ${fmt(times.at(-1))}`,
  );
  return result;
}

const scanAt = (root, alias) => () => scanOrigin(root, { alias, type: 'local', path: root });

const tmp = await realpath(await mkdtemp(join(tmpdir(), 'palm-bench-scan-')));
try {
  const root = join(tmp, 'repo');
  const files = await writeSyntheticOrigin(root, plugins);
  const want = Object.values(syntheticCounts(plugins)).reduce((a, b) => a + b, 0);
  const r = await bench(`synthetic: ${files} files, ${want} entities`, runs, scanAt(root, 'bench'));
  if (r.entities.length !== want)
    throw new Error(`expected ${want} entities, scanned ${r.entities.length}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const fixture = fileURLToPath(new URL('../test/fixtures/cursor-monorepo-like', import.meta.url));
const f = await bench('fixture cursor-monorepo-like', fixtureRuns, scanAt(fixture, 'cursor'));
console.log(
  `  ${f.entities.length} entities, ${f.warnings.length} warnings, detected ${f.detected}`,
);
