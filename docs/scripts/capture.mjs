#!/usr/bin/env node
// Records real palm terminal sessions for the docs, so no page ever shows invented output.
//
//   node scripts/capture.mjs              rerun every capture in capture-specs.mjs
//   node scripts/capture.mjs <name>...    rerun only these captures
//   node scripts/capture.mjs --check      exit 1 when a committed capture differs from a fresh run
//
// Build the CLI first (`npm run build` at the repository root): captures run `node ../dist/cli.js`.
// Every capture gets a throwaway sandbox: HOME and PALM_HOME point into a temp directory, fixture
// origins are copied from test/fixtures, the environment is an allowlist (no tokens, no harness
// overrides, no global git config), colour is off and output is not a terminal. Paths inside the
// sandbox home print as ~, and tables are re-padded to match. Output goes to
// src/captures/<name>.txt (and <name>.files.txt).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specs } from './capture-specs.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(DOCS, '..');
const CLI = join(REPO, 'dist', 'cli.js');
const FIXTURES = join(REPO, 'test', 'fixtures');
const OUT = join(DOCS, 'src', 'captures');
const ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'LANG', 'SHELL'];

function makeSandbox() {
  const raw = mkdtempSync(join(tmpdir(), 'palm-capture-'));
  const root = realpathSync(raw);
  const home = join(root, 'home');
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, 'src'));
  const env = { HOME: home, PALM_HOME: join(home, '.palm') };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { CI: '1', NO_COLOR: '1', TERM: 'dumb', GIT_CONFIG_NOSYSTEM: '1' });
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0' });
  // Longest first, so /private/var/... is replaced before /var/...
  const homes = [...new Set([join(raw, 'home'), home])].sort((a, b) => b.length - a.length);
  return { root, home, project, env, homes };
}

/** Run one command with stdout and stderr interleaved in order, as a terminal shows them. */
function run(box, command, args) {
  const log = join(box.root, 'output.log');
  const fd = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: box.project,
      env: box.env,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  if (result.error) throw result.error;
  return { status: result.status, output: readFileSync(log, 'utf8') };
}

function palm(box, args) {
  // `~/x` and `file://~/x` expand as a shell would expand `~/x`.
  const expanded = args.map((a) =>
    a.replace(/^(file:\/\/)?~\//, (_, s) => `${s ?? ''}${box.home}/`),
  );
  return run(box, process.execPath, [CLI, ...expanded]);
}

// Shell steps commit with a fixed identity and date, so git origins get the same shas every run.
const GIT_FIXED = {
  GIT_AUTHOR_NAME: 'palm docs',
  GIT_AUTHOR_EMAIL: 'docs@example.com',
  GIT_AUTHOR_DATE: '2026-09-28T12:00:00Z',
  GIT_COMMITTER_NAME: 'palm docs',
  GIT_COMMITTER_EMAIL: 'docs@example.com',
  GIT_COMMITTER_DATE: '2026-09-28T12:00:00Z',
};

/** A bash step in ~/project; $FIXTURES points at test/fixtures. */
function sh(box, script) {
  const env = { ...box.env, ...GIT_FIXED, FIXTURES };
  return run({ ...box, env }, 'bash', ['-c', script]);
}

/** One step: a palm argument list, { palm, exit } for an expected exit code, or { sh, exit }. */
function runStep(box, step) {
  const palmArgs = Array.isArray(step) ? step : step.palm;
  const shown = palmArgs ? `palm ${palmArgs.map(quote).join(' ')}` : step.sh;
  const result = palmArgs ? palm(box, palmArgs) : sh(box, step.sh);
  const exit = step.exit ?? 0;
  if (result.status !== exit)
    throw new Error(`${shown} exited ${result.status}, expected ${exit}:\n${result.output}`);
  return { shown, output: result.output };
}

function mustSucceed(what, { status, output }) {
  if (status !== 0) throw new Error(`${what} exited ${status}:\n${output}`);
  return output;
}

function addOrigins(box, origins = []) {
  for (const { fixture, dir, alias } of origins) {
    cpSync(join(FIXTURES, fixture), join(box.home, 'src', dir), { recursive: true });
    mustSucceed(`origin ${alias}`, palm(box, ['origin', 'add', `~/src/${dir}`, '--alias', alias]));
  }
}

/** Shell-quote an argument for display. */
function quote(arg) {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function tidyLine(box, line) {
  let out = line;
  for (const home of box.homes) out = out.replaceAll(home, '~');
  return out.trimEnd();
}

const RULE = /^─+(?: +─+)*$/;

/** Start column of every segment of a table rule such as `─────  ───`. */
function columnStarts(rule) {
  return [...rule.matchAll(/─+/g)].map((m) => m.index);
}

/** A table row fills the first two columns and leaves the two-space gap before every later one. */
function isRow(line, starts) {
  const gap = (s) => s === 0 || s > line.length + 1 || line.slice(s - 2, s) === '  ';
  return line.length > starts[1] && starts.every(gap);
}

/** Re-pad a palm table (header, rule, rows) after ~ replaced the sandbox home in its cells. */
function realign(box, lines, starts) {
  const cells = lines.map((l) =>
    starts.map((s, i) => tidyLine(box, l.slice(s, starts[i + 1] ?? l.length))),
  );
  const widths = starts.map((_, i) =>
    Math.max(...cells.filter((_, r) => r !== 1).map((row) => row[i].length)),
  );
  return cells.map((row, r) =>
    (r === 1 ? widths.map((w) => '─'.repeat(w)) : row.map((c, i) => c.padEnd(widths[i])))
      .join('  ')
      .trimEnd(),
  );
}

function tidy(box, text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const starts = RULE.test(lines[i + 1] ?? '') ? columnStarts(lines[i + 1]) : [];
    if (starts.length < 2) {
      out.push(tidyLine(box, lines[i]));
      continue;
    }
    let end = i + 2;
    while (end < lines.length && isRow(lines[end], starts)) end++;
    out.push(...realign(box, lines.slice(i, end), starts));
    i = end - 1;
  }
  return out.join('\n');
}

/** Relative path -> content hash for every file under dir, skipping .git. */
function snapshot(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(abs, base, out);
    else out.set(relative(base, abs), createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

function changedFiles(before, after) {
  return [...after.keys()].filter((f) => before.get(f) !== after.get(f)).sort();
}

/** Run one spec in its own sandbox; returns the files it would write. */
function capture(spec) {
  const box = makeSandbox();
  try {
    mustSucceed('git init', run(box, 'git', ['init', '-q', box.project]));
    addOrigins(box, spec.origins);
    for (const step of spec.setup ?? []) runStep(box, step);
    const before = snapshot(box.project);
    const session = [];
    for (const step of spec.commands) {
      const { shown, output } = runStep(box, step);
      session.push(`$ ${shown}`, tidy(box, output).trimEnd());
    }
    const files = { [`${spec.name}.txt`]: `${session.join('\n')}\n` };
    if (spec.files) {
      const changed = changedFiles(before, snapshot(box.project));
      files[`${spec.name}.files.txt`] = `${changed.join('\n')}\n`;
    }
    return files;
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
}

function selectSpecs(names) {
  const unknown = names.filter((n) => !specs.some((s) => s.name === n));
  if (unknown.length) throw new Error(`unknown capture: ${unknown.join(', ')}`);
  return names.length ? specs.filter((s) => names.includes(s.name)) : specs;
}

/** Write one capture file, or with `check` compare it; returns true when the committed file is stale. */
function emit(file, text, check) {
  const path = join(OUT, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (!check) writeFileSync(path, text);
  process.stdout.write(`${check ? 'checked' : 'wrote'} src/captures/${file}\n`);
  return check && current !== text;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  if (!existsSync(CLI))
    throw new Error(`${CLI} not found: run npm run build at the repository root`);
  mkdirSync(OUT, { recursive: true });
  const stale = [];
  for (const spec of selectSpecs(argv.filter((a) => a !== '--check'))) {
    for (const [file, text] of Object.entries(capture(spec))) {
      if (emit(file, text, check)) stale.push(file);
    }
  }
  if (stale.length) {
    process.stderr.write(`stale captures (run npm run capture): ${stale.join(', ')}\n`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`capture: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
