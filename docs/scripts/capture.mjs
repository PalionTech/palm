#!/usr/bin/env node
// Records real palm terminal sessions for the docs, so no page ever shows invented output.
//
//   node scripts/capture.mjs              rerun every capture in capture-specs.mjs
//   node scripts/capture.mjs <name>...    rerun only these captures
//   node scripts/capture.mjs --check      exit 1 when a committed capture differs from a fresh run
//
// Build the CLI first (`npm run build` at the repository root): captures run `node ../dist/cli.js`.
// Every capture gets a throwaway sandbox: HOME and PALM_HOME point into a temp directory, the
// environment is an allowlist (no tokens, no harness overrides, no system git config), colour is
// off and output is not a terminal. Paths inside the sandbox home print as ~, and tables are
// re-padded to match. The size `palm cache clean` reports prints as <size>, since a checkout's
// bytes depend on the git that made it. Output goes to src/captures/<name>.txt (and
// <name>.files.txt).
//
// Sources: each `sources` entry of a spec becomes a git repository at ~/src/<owner>/<repo>, built
// from a fixture in test/fixtures (or a shell script), committed with a fixed identity and date,
// and tagged. A `git daemon` on 127.0.0.1 serves ~/src, and the sandbox's global git config
// rewrites https://github.com/<owner>/<repo>(.git) to it. `palm install mattpocock/skills tdd`
// therefore resolves the GitHub shorthand as it would online, records the github.com URL in the
// lock, and never reaches the network. `git daemon` ships with git on macOS and Debian/Ubuntu.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
  // `palm` on PATH for shell steps, such as `palm install mcp --snippet - <<'JSON'`.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'palm'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, 'palm'), 0o755);
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '');
  const env = { HOME: home, PALM_HOME: join(home, '.palm') };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.PATH = `${bin}:${env.PATH ?? '/usr/bin:/bin'}`;
  Object.assign(env, { CI: '1', NO_COLOR: '1', TERM: 'dumb', GIT_CONFIG_NOSYSTEM: '1' });
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: gitconfig });
  // Longest first, so /private/var/... is replaced before /var/...
  const homes = [...new Set([join(raw, 'home'), home])].sort((a, b) => b.length - a.length);
  return { root, home, project, env, homes, gitconfig, allowExec: undefined };
}

/** Everything written to `fd` so far, read from its start through the descriptor itself. */
function readAll(fd) {
  const buf = Buffer.alloc(fstatSync(fd).size);
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, read);
    if (n === 0) break;
    read += n;
  }
  return buf.toString('utf8', 0, read);
}

/**
 * Run one command (an argument array, no shell) with stdout and stderr interleaved in order, as
 * a terminal shows them: both go to one log file, read back through the descriptor they wrote.
 */
function run(box, command, args, cwd = box.project, env = box.env) {
  const fd = openSync(join(box.root, 'output.log'), 'w+');
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd] });
    if (result.error) throw result.error;
    return { status: result.status, output: readAll(fd) };
  } finally {
    closeSync(fd);
  }
}

function palm(box, args) {
  // `~/x` and `file://~/x` expand as a shell would expand `~/x`.
  const expanded = args.map((a) =>
    a.replace(/^(file:\/\/)?~\//, (_, s) => `${s ?? ''}${box.home}/`),
  );
  return run(box, process.execPath, [CLI, ...expanded]);
}

// Shell steps commit with a fixed identity and date, so git sources get the same shas every run.
const GIT_FIXED = {
  GIT_AUTHOR_NAME: 'palm docs',
  GIT_AUTHOR_EMAIL: 'docs@example.com',
  GIT_AUTHOR_DATE: '2026-09-28T12:00:00Z',
  GIT_COMMITTER_NAME: 'palm docs',
  GIT_COMMITTER_EMAIL: 'docs@example.com',
  GIT_COMMITTER_DATE: '2026-09-28T12:00:00Z',
};

/**
 * A bash step, in ~/project unless `cwd` says otherwise; $FIXTURES is test/fixtures, $SRC is ~/src
 * and $ALLOW_EXEC the last `--allow-exec` value. The script is the spec's text as written: values
 * known only at run time reach it as environment variables, never spliced into the shell string.
 */
function sh(box, script, cwd = box.project) {
  const env = { ...box.env, ...GIT_FIXED, FIXTURES, SRC: join(box.home, 'src') };
  if (box.allowExec) env.ALLOW_EXEC = box.allowExec;
  return run(box, 'bash', ['-c', script], cwd, env);
}

/** `{{allow-exec}}` in a step: the `--allow-exec` value an earlier step printed. */
function substitute(box, text) {
  if (!text.includes('{{allow-exec}}')) return text;
  if (!box.allowExec)
    throw new Error('{{allow-exec}} used, but no earlier step printed --allow-exec');
  return text.replaceAll('{{allow-exec}}', box.allowExec);
}

/**
 * One step: a palm argument list, { palm, exit } for an expected exit code, or { sh, exit }.
 * `{{allow-exec}}` in an argument or script becomes the `--allow-exec` value the last step that
 * printed one showed: the hash-pinned consent a person copies from the error. A script shows the
 * value and runs with `"$ALLOW_EXEC"` in its place.
 */
function runStep(box, step) {
  const rawArgs = Array.isArray(step) ? step : step.palm;
  const palmArgs = rawArgs?.map((a) => substitute(box, a));
  const shown = palmArgs ? `palm ${palmArgs.map(quote).join(' ')}` : substitute(box, step.sh);
  const result = palmArgs
    ? palm(box, palmArgs)
    : sh(box, step.sh.replaceAll('{{allow-exec}}', '"$ALLOW_EXEC"'));
  const exit = step.exit ?? 0;
  if (result.status !== exit)
    throw new Error(`${shown} exited ${result.status}, expected ${exit}:\n${result.output}`);
  const allow = [...result.output.matchAll(/--allow-exec[ =](\S+)/g)].at(-1);
  if (allow && !allow[1].startsWith('<')) box.allowExec = allow[1];
  return { shown, output: result.output };
}

function mustSucceed(what, { status, output }) {
  if (status !== 0) throw new Error(`${what} exited ${status}:\n${output}`);
  return output;
}

/** A free TCP port on 127.0.0.1, found by a short-lived child (the runner is synchronous). */
function freePort() {
  const probe =
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  if (r.status !== 0 || !/^\d+$/.test(r.stdout)) throw new Error(`no free port: ${r.stderr}`);
  return Number(r.stdout);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One source as a committed, tagged repository in `dir`; git runs with argument arrays, no shell. */
function buildSource(box, dir, source) {
  mkdirSync(dir, { recursive: true });
  if (source.fixture) cpSync(join(FIXTURES, source.fixture), dir, { recursive: true });
  if (source.sh) mustSucceed(`source ${source.repo}`, sh(box, source.sh, dir));
  const steps = [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
  ];
  steps.push(['commit', '-qm', source.message ?? 'release']);
  for (const tag of source.tags ?? []) steps.push(['tag', tag]);
  const env = { ...box.env, ...GIT_FIXED };
  for (const args of steps)
    mustSucceed(`repository ${source.repo}`, run(box, 'git', args, dir, env));
}

/**
 * Build every source of a spec as a tagged repository under ~/src/<owner>/<repo>, serve ~/src with
 * git daemon, and point https://github.com/<owner>/<repo> at it. Returns the daemon process.
 *
 *   { fixture: 'mattpocock-like', repo: 'mattpocock/skills', tags: ['v1.2.3'] }
 *   { repo: 'trailofbits/skills', tags: ['v2.1.0'], sh: '<bash, run in the empty repository>' }
 *
 * Later history, such as a new tag for `palm update`, is a setup step:
 * `cd $SRC/<owner>/<repo> && git commit -qam next && git tag v1.3.0`. The daemon serves the
 * working tree, so palm sees the new tag at once.
 */
function serveSources(box, sources = []) {
  if (sources.length === 0) return undefined;
  const srcRoot = join(box.home, 'src');
  for (const source of sources) buildSource(box, join(srcRoot, ...source.repo.split('/')), source);
  const port = freePort();
  const daemonArgs = ['daemon', '--reuseaddr', '--export-all', `--base-path=${srcRoot}`];
  daemonArgs.push('--listen=127.0.0.1', `--port=${port}`, srcRoot);
  const daemon = spawn('git', daemonArgs, { stdio: 'ignore' });
  const rewrites = sources.map(
    ({ repo }) =>
      `[url "git://127.0.0.1:${port}/${repo}"]\n` +
      `\tinsteadOf = https://github.com/${repo}.git\n` +
      `\tinsteadOf = https://github.com/${repo}\n`,
  );
  writeFileSync(box.gitconfig, rewrites.join(''));
  const probe = `git://127.0.0.1:${port}/${sources[0].repo}`;
  for (let i = 0; ; i++) {
    const r = spawnSync('git', ['ls-remote', probe], { env: box.env, stdio: 'ignore' });
    if (r.status === 0) break;
    if (i === 50) {
      daemon.kill();
      throw new Error(`git daemon did not serve ${probe}`);
    }
    sleep(100);
  }
  return daemon;
}

/** Shell-quote an argument for display. */
function quote(arg) {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * The size `palm cache clean` reports: the bytes of a git checkout, which vary with the git that
 * made it, so a capture shows `<size>` and stays the same on every machine.
 */
const CACHE_SIZE = /(~\/\.palm\/cache) \(\d+(?:\.\d+)? [KMGT]?B\)/g;

function tidyLine(box, line) {
  let out = line;
  for (const home of box.homes) out = out.replaceAll(home, '~');
  return out.replace(CACHE_SIZE, '$1 (<size>)').trimEnd();
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
  let daemon;
  try {
    mustSucceed('git init', run(box, 'git', ['init', '-q', box.project]));
    daemon = serveSources(box, spec.sources);
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
    daemon?.kill();
    rmSync(box.root, { recursive: true, force: true });
  }
}

function selectSpecs(names) {
  const unknown = names.filter((n) => !specs.some((s) => s.name === n));
  if (unknown.length) throw new Error(`unknown capture: ${unknown.join(', ')}`);
  return names.length ? specs.filter((s) => names.includes(s.name)) : specs;
}

/** The text of `path`, or undefined when there is no such file (read, not checked first). */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Write one capture file, or with `check` compare it; returns true when the committed file is stale. */
function emit(file, text, check) {
  const path = join(OUT, file);
  const current = readIfExists(path);
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
