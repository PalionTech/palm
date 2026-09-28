#!/usr/bin/env node
// Lint ratchet: `biome lint` findings may only go down.
//
//   node scripts/lint-ratchet.mjs            check against scripts/lint-baseline.json
//   node scripts/lint-ratchet.mjs --update   rewrite the baseline (refuses to raise a count)
//
// Counts every lint diagnostic per rule (any severity) plus every `biome-ignore` suppression
// comment per rule, so silencing a finding does not escape the ratchet either. Fails when a
// rule's count exceeds its baseline. Formatting and import order are not counted here: they
// must be clean (`biome check --linter-enabled=false .` runs before this in `npm run lint`).
// Each wave that fixes findings lowers the baseline with --update in the same commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'lint-baseline.json');
const update = process.argv.includes('--update');

function lintCounts() {
  const biome = join(root, 'node_modules', '.bin', 'biome');
  const r = spawnSync(biome, ['lint', '--reporter=json', '--max-diagnostics=none', '.'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`biome lint did not produce a JSON report:\n${r.stderr || r.stdout}`);
  }
  const counts = {};
  const other = [];
  for (const d of report.diagnostics) {
    if (d.category?.startsWith('lint/')) {
      const rule = d.category.slice('lint/'.length);
      counts[rule] = (counts[rule] ?? 0) + 1;
    } else other.push(`${d.location?.path ?? '?'}: ${d.category}: ${d.message}`);
  }
  if (other.length) throw new Error(`biome reported non-lint problems:\n${other.join('\n')}`);
  return counts;
}

/** Files Biome lints: tracked or untracked-but-not-ignored, minus fixtures. */
function lintedFiles() {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  const listed = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : walk(root);
  return listed.filter(
    (f) => /\.(c|m)?[jt]s$/.test(f) && !/(^|\/)fixtures\//.test(f) && existsSync(join(root, f)),
  );
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(e.name)) return [];
    const abs = join(dir, e.name);
    return e.isDirectory() ? walk(abs) : [relative(root, abs)];
  });
}

function suppressionCounts() {
  const counts = {};
  const re = /biome-ignore(?:-all|-start)?\s+lint\/([\w-]+\/[\w-]+)/g;
  for (const file of lintedFiles()) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(re)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every `<section>.<rule>` whose current count is above (worse) or below (better) the baseline. */
function compare(current, baseline) {
  const worse = [];
  const better = [];
  for (const section of ['diagnostics', 'suppressions']) {
    const now = current[section];
    const base = baseline[section] ?? {};
    for (const rule of new Set([...Object.keys(now), ...Object.keys(base)])) {
      const n = now[rule] ?? 0;
      const b = base[rule] ?? 0;
      if (n > b) worse.push(`${section} ${rule}: ${n} (baseline ${b})`);
      else if (n < b) better.push(`${section} ${rule}: ${n} (baseline ${b})`);
    }
  }
  return { worse, better };
}

const current = { diagnostics: sorted(lintCounts()), suppressions: sorted(suppressionCounts()) };
const baseline = readBaseline();
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const { worse, better } = baseline ? compare(current, baseline) : { worse: [], better: [] };

if (update) {
  if (worse.length) {
    console.error(`refusing to raise the lint baseline:\n  ${worse.join('\n  ')}`);
    process.exit(1);
  }
  const note =
    'Lint ratchet baseline (scripts/lint-ratchet.mjs): counts may only go down. Lower them with `npm run lint:baseline` after fixing findings.';
  writeFileSync(baselinePath, `${JSON.stringify({ note, ...current }, null, 2)}\n`);
  console.log(
    `lint baseline written: ${total(current.diagnostics)} diagnostics, ${total(current.suppressions)} suppressions`,
  );
  process.exit(0);
}

if (!baseline) {
  console.error('no scripts/lint-baseline.json; create it with `npm run lint:baseline`');
  process.exit(1);
}
if (worse.length) {
  console.error(`lint ratchet: new findings above the baseline:\n  ${worse.join('\n  ')}`);
  console.error('run `npx biome lint .` to see them; fix them rather than raising the baseline.');
  process.exit(1);
}
console.log(
  `lint ratchet ok: ${total(current.diagnostics)} diagnostics, ${total(current.suppressions)} suppressions (baseline ${total(baseline.diagnostics)}/${total(baseline.suppressions ?? {})})`,
);
if (better.length) {
  console.log(
    `  below baseline, lower it with \`npm run lint:baseline\`:\n  ${better.join('\n  ')}`,
  );
}
