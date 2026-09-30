/**
 * `palm install` (aliases `add`, `i`), DESIGN.md §6 and PLAN.md §4.9:
 *
 * - `palm install <source> [--grep text]`: fetch, index and list what it offers; save nothing;
 * - `palm install <source> [kind:]name... | --all`: install, recording the source and the
 *   entries in palm.yaml and the lock;
 * - `palm install`: make the disk match palm.yaml and the lock.
 *
 * Every command it suggests names the source as the person can paste it: the key once palm.yaml
 * declares it, else what they typed (K9). `palm install mcp …` is src/commands/mcp.ts.
 */
import { isPalmError, PalmError } from '../core/errors.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { Entity, EntityRefSpec, InstallRequest, PalmContext } from '../core/types.js';
import type { ScopeState, SourceListing } from '../create/engine.js';
import type { App } from './app.js';
import { type Invocation, interpretInstall, usage } from './grammar.js';
import { formatName, type GrammarContext, palmLine, scopeFlag } from './hints.js';
import { grammarContext } from './known.js';
import { type RemovedFlags, removedFlagError } from './legacy.js';
import { listingJson, printListing } from './listing.js';
import { interruptible, reportInstall } from './report.js';
import {
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  parseTargetList,
  scopeOf,
  withSpinner,
} from './shared.js';

interface InstallFlags extends GlobalOptions, RemovedFlags {
  all?: boolean;
  as?: string;
  targets?: string;
  /** The second spelling of --targets. */
  target?: string;
  at?: string;
  grep?: string;
}

interface NamedInstall {
  before: ScopeState;
  source: string;
  names: EntityRefSpec[];
  flags: InstallFlags;
}

/** `isExecutable` for every entity of a listing, asked once each. */
async function executables(app: App, entities: Entity[]): Promise<(e: Entity) => boolean> {
  const api = engine(app);
  const found = new Set<Entity>();
  for (const e of entities) if (await api.isExecutable(e)) found.add(e);
  return (e) => found.has(e);
}

/** What was typed, as the paste lines repeat it (with `--as` after the names). */
function typedLine(job: NamedInstall) {
  const as = job.flags.as ? ['--as', job.flags.as] : [];
  const scope = job.before.paths.scope;
  return (source: string, names: readonly string[]) =>
    palmLine('install', [source, ...names, ...(source === job.source ? as : [])], scope);
}

/** K9, D9: the key once palm.yaml declares the source, else the input as typed (its #ref kept). */
function pasteSource(listed: SourceListing, job: NamedInstall): string {
  return listed.declared && !job.source.includes('#') ? listed.source.name : job.source;
}

/** L15: index notes for maintainers are one count line; the details under describe or PALM_DEBUG. */
function noteIndexWarnings(app: App, listed: SourceListing, job: NamedInstall): void {
  const { warnings } = listed.index;
  if (!warnings.length || app.out.jsonMode) return;
  for (const w of warnings) app.out.debug(w);
  const g = scopeFlag(job.before.paths.scope);
  const see = listed.declared
    ? `palm describe source ${listed.source.name}${g}`
    : `PALM_DEBUG=1 palm install ${job.source}${g}`;
  const n = warnings.length;
  app.out.info(
    `${n} ${n === 1 ? 'note' : 'notes'} from indexing ${listed.source.name} (see: ${see})`,
  );
}

async function list(ctx: PalmContext, app: App, job: NamedInstall) {
  const api = engine(app);
  const scope = job.before.paths.scope;
  const listed: SourceListing = await withSpinner(ctx, `Fetching ${job.source}`, () =>
    api.listSource(ctx, job.source, { scope }, engineDeps(app)),
  );
  const executable = await executables(app, listed.index.entities);
  noteIndexWarnings(app, listed, job);
  const line = typedLine(job);
  const source = pasteSource(listed, job);
  const view = { line: (names: readonly string[]) => line(source, names), grep: job.flags.grep };
  if (app.out.jsonMode) app.out.json(listingJson(listed, executable, view));
  else printListing(app.out, listed, executable, view);
}

function requestOf(job: NamedInstall): InstallRequest {
  const { flags } = job;
  const targets = parseTargetList(flags.targets ?? flags.target, '--targets');
  return {
    source: job.source,
    names: job.names,
    ...(flags.all ? { all: true } : {}),
    ...(targets ? { targets } : {}),
    ...(flags.at ? { at: flags.at } : {}),
    ...(flags.as ? { as: flags.as } : {}),
  };
}

const NOT_IN_SOURCE = /^"([^"]+)" is not in source .*; did you mean ([^?]+)\?$/;
const TWO_KINDS = /^"([^"]+)" names \d+ kinds in source [^:]+: ([^,\s]+)/;

/** The names of this run with the one an error named replaced by the form it suggests. */
function correctedNames(e: PalmError, names: EntityRefSpec[]): string[] | undefined {
  const m = NOT_IN_SOURCE.exec(e.message) ?? TWO_KINDS.exec(e.message);
  if (!m) return undefined;
  const [, wrong, right = ''] = m;
  return names.map((n) => (formatName(n) === wrong || n.name === wrong ? right : formatName(n)));
}

/**
 * K9, L20: an error's command names the source as typed until palm.yaml declares it, and keeps
 * every name of a multi-name install (one suggestion replaced). The run installed nothing.
 */
function pasteable(e: unknown, app: App, job: NamedInstall): unknown {
  if (!isPalmError(e) || !e.hint?.startsWith('palm install ')) return e;
  const corrected = correctedNames(e, job.names);
  const word = /^palm install (\S+)/.exec(e.hint)?.[1] ?? '';
  const known = looksLikeSourceInput(word) || job.before.sources.byName(word) !== undefined;
  if (!corrected && known) return e;
  if (job.names.length > 1 && !app.out.jsonMode) app.out.out('Nothing installed.');
  const line = typedLine(job);
  const hint = corrected
    ? line(job.source, corrected)
    : e.hint.replace(`palm install ${word}`, `palm install ${job.source}`);
  return new PalmError(e.code, e.message, hint, e.retryWith ? { retryWith: e.retryWith } : {});
}

/** B11: `at:` is recorded now and honoured in 0.3; say so once per directory. */
function noteAt(app: App, job: NamedInstall, placed: readonly (string | undefined)[]): void {
  const dirs = new Set([job.flags.at, ...placed].filter((d): d is string => Boolean(d)));
  for (const dir of dirs) app.out.info(`at ${dir} (placed at the root until 0.3)`);
}

async function installNames(ctx: PalmContext, app: App, job: NamedInstall): Promise<void> {
  const api = engine(app);
  const scope = job.before.paths.scope;
  const req = requestOf(job);
  const result = await interruptible(app, () =>
    api.installFromSource(ctx, req, { scope }, engineDeps(app)),
  ).catch((e: unknown) => {
    throw pasteable(e, app, job);
  });
  const after = await api.openScope(ctx, scope, { readOnly: true });
  if (!app.out.jsonMode) {
    noteNewSource(app, job, after);
    noteAt(
      app,
      job,
      result.outcomes.map((o) => o.entry.at),
    );
  }
  const typed = job.flags.as ? `${job.source} --as ${job.flags.as}` : job.source;
  const sourceWord = (name: string) => (after.sources.byName(name) ? name : typed);
  const report = { before: job.before, after, from: job.names.length > 0, named: true };
  await reportInstall(ctx, app, result, { ...report, sourceWord, explicit: job.names });
}

/** A source this run declared under a name other than what was typed (a URL, `--as`): its name. */
function noteNewSource(app: App, job: NamedInstall, after: ScopeState): void {
  const typed = job.source.split('#')[0] ?? job.source;
  for (const s of after.sources.all())
    if (!job.before.sources.byName(s.name) && s.name !== typed)
      app.out.mark('+', `source ${s.name} → palm.yaml`);
}

async function sync(ctx: PalmContext, app: App, before: ScopeState): Promise<void> {
  const api = engine(app);
  const scope = before.paths.scope;
  const result = await interruptible(app, () => api.syncScope(ctx, { scope }, engineDeps(app)));
  const after = await api.openScope(ctx, scope, { readOnly: true });
  if (!result.outcomes.length && !result.failures.length && !app.out.jsonMode) {
    app.out.info('nothing to install: palm.yaml lists no entries');
    app.out.hint(
      `see what a source offers, for example: ${palmLine('install', ['mattpocock/skills'], scope)}`,
    );
  }
  await reportInstall(ctx, app, result, { before, after });
}

/** `--all` and `--targets` need names to act on; a bare install follows palm.yaml (E7). */
function checkBare(flags: InstallFlags, gctx: GrammarContext): void {
  const scope = gctx.scope;
  const example = gctx.sources?.[0]?.name ?? 'obra/superpowers';
  if (flags.all)
    throw usage(
      '--all needs the source to take everything from',
      palmLine('install', [example, '--all'], scope),
    );
  const targets = flags.targets ?? flags.target;
  if (targets === undefined) return;
  const manifest = scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  throw usage(
    `--targets narrows the entries an install names; palm install alone follows targets: in ${manifest}`,
    `add ${targets} to targets: in ${manifest}, then run: ${palmLine('install', [], scope)}`,
  );
}

/** E4: `palm install --frozen` (palm 0.1 CI) is `palm check` now; it prints so and runs it. */
async function frozen(inv: Invocation, app: App): Promise<void> {
  const g = inv.opts.global ? ' -g' : '';
  app.out.info(`palm install --frozen is now: palm check${g}`);
  const { run: check } = await import('./check.js');
  return check({ ...inv, command: 'check', names: [], words: [] }, app);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as InstallFlags;
  const words = inv.words ?? [];
  if (flags.frozen) return frozen(inv, app);
  const removed = removedFlagError(words, flags, app.argv);
  if (removed) throw removed;
  const ctx = await makeContext(app, flags);
  const before = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
  const gctx = await grammarContext(ctx, app, before, words);
  if (!words.length) {
    checkBare(flags, gctx);
    return sync(ctx, app, before);
  }
  const w = interpretInstall(words, gctx);
  if (w.legacy) app.out.info(`${w.legacy.form} is now: ${w.legacy.replacement}`);
  const job = { before, source: w.source ?? '', names: w.names, flags };
  if (!w.names.length && !flags.all) return list(ctx, app, job);
  return installNames(ctx, app, job);
}
