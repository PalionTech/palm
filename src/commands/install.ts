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
import { existsSync } from 'node:fs';
import type { Entity, InstallRequest, LayoutDescriptor, PalmContext } from '../core/types.js';
import type { ScopeState, SourceListing } from '../create/engine.js';
import { parseLayoutFlags } from '../index/layout-flags.js';
import { indexNotes } from '../index/notes.js';
import type { App } from './app.js';
import { type Invocation, interpretInstall, usage } from './grammar.js';
import {
  type GrammarContext,
  manifestFile,
  palmLine,
  pasteLine,
  shellWord,
  sourceOptions,
  typedOptions,
} from './hints.js';
import { type InstallJob, pasteable } from './install-errors.js';
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
  /** `--layout kind=glob`, repeatable (K2). */
  layout?: string[];
}

interface NamedInstall extends InstallJob {
  flags: InstallFlags;
}

/** `isExecutable` for every entity of a listing, asked once each. */
async function executables(app: App, entities: Entity[]): Promise<(e: Entity) => boolean> {
  const api = engine(app);
  const found = new Set<Entity>();
  for (const e of entities) if (await api.isExecutable(e)) found.add(e);
  return (e) => found.has(e);
}

/** Options a line that installs from the typed source repeats (T9, N7). */
const ENTRY_OPTIONS: ReadonlySet<string> = new Set([
  '--as',
  '--layout',
  '--targets',
  '--target',
  '--at',
]);

/**
 * What was typed, as the paste lines repeat it: the typed source keeps `--as`, `--layout` and
 * the targets it was given (T9); a declared key needs none of them.
 */
function typedLine(job: NamedInstall, argv: readonly string[]) {
  const scope = job.before.paths.scope;
  const options = typedOptions(argv, (name) => ENTRY_OPTIONS.has(name));
  return (source: string, names: readonly string[]) =>
    pasteLine('install', [source, ...names], source === job.source ? options : [], scope);
}

/** K9, D9: the key once palm.yaml declares the source, else the input as typed (its #ref kept). */
function pasteSource(listed: SourceListing, job: NamedInstall): string {
  if (listed.paste !== undefined) return listed.paste;
  return listed.declared && !job.source.includes('#') ? listed.source.name : job.source;
}

/** K2: the `layout:` a new source gets, from `--layout kind=glob`. */
function layoutOf(flags: InstallFlags): { layout?: LayoutDescriptor } {
  return flags.layout?.length ? { layout: parseLayoutFlags(flags.layout) } : {};
}

/**
 * L15, N1, Q18: notes a person acts on print in full; the other index notes are one count line
 * with one pointer, `palm describe source <source>` (each also under PALM_DEBUG).
 */
function noteIndexWarnings(app: App, listed: SourceListing, job: NamedInstall): void {
  const { warnings } = listed.index;
  if (!warnings.length || app.out.jsonMode) return;
  const scope = job.before.paths.scope;
  const as = typedOptions(app.argv, (name) => name === '--as');
  const install = (args: readonly string[]) =>
    pasteLine('install', [job.source, ...args], as, scope);
  const { shown, rest } = indexNotes(
    warnings,
    listed.declared ? { declared: true } : { declared: false, install },
  );
  for (const w of shown) app.out.info(`${listed.source.name}: ${w}`);
  for (const w of rest) app.out.debug(w);
  if (!rest.length) return;
  const source = listed.declared ? listed.source.name : job.source;
  const see = pasteLine('describe', ['source', source], [], scope);
  const n = `${rest.length}${shown.length ? ' more' : ''}`;
  const notes = rest.length === 1 ? 'note' : 'notes';
  app.out.info(`${n} ${notes} from indexing ${listed.source.name} (see: ${see})`);
}

async function list(ctx: PalmContext, app: App, job: NamedInstall) {
  const api = engine(app);
  const scope = job.before.paths.scope;
  const listed: SourceListing = await withSpinner(ctx, `Fetching ${job.source}`, () =>
    api.listSource(ctx, job.source, { scope, ...layoutOf(job.flags) }, engineDeps(app)),
  ).catch((e: unknown) => {
    throw pasteable(e, app, job);
  });
  const executable = await executables(app, listed.index.entities);
  noteIndexWarnings(app, listed, job);
  const line = typedLine(job, app.argv);
  const source = pasteSource(listed, job);
  const view = {
    line: (names: readonly string[]) => line(source, names),
    grep: job.flags.grep,
    ...(job.flags.as && !listed.declared ? { title: job.flags.as } : {}),
  };
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
    ...layoutOf(flags),
  };
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
  const typed = [job.source, ...sourceOptions(app.argv)].map(shellWord).join(' ');
  const sourceWord = (name: string) => (after.sources.byName(name) ? name : typed);
  const report = { before: job.before, after, from: job.names.length > 0, named: true };
  await reportInstall(ctx, app, result, { ...report, sourceWord, explicit: job.names });
}

/** A source this run declared under a name other than what was typed (a URL, `--as`): its name. */
function noteNewSource(app: App, job: NamedInstall, after: ScopeState): void {
  const typed = job.source.split('#')[0] ?? job.source;
  const file = manifestFile(after.paths.scope);
  for (const s of after.sources.all())
    if (!job.before.sources.byName(s.name) && s.name !== typed)
      app.out.mark('+', `source ${s.name} → ${file}`);
}

async function sync(ctx: PalmContext, app: App, before: ScopeState): Promise<void> {
  const api = engine(app);
  const scope = before.paths.scope;
  const result = await interruptible(app, () => api.syncScope(ctx, { scope }, engineDeps(app)));
  const after = await api.openScope(ctx, scope, { readOnly: true });
  if (!result.outcomes.length && !result.failures.length && !app.out.jsonMode) {
    const file = manifestFile(scope);
    const none = !existsSync(before.paths.manifestFile);
    app.out.info(none ? `no ${file} here` : `nothing to install: ${file} lists no entries`);
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
  const manifest = manifestFile(scope);
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
  const ctx = await makeContext(app, flags);
  const before = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
  const gctx = await grammarContext(ctx, app, before, words);
  const removed = removedFlagError(words, flags, app.argv, gctx);
  if (removed) throw removed;
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
