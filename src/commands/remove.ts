/**
 * `palm remove [source] <[kind:]name…>` (aliases `uninstall`, `rm`), DESIGN.md §6 "Remove":
 * delete exactly the lock's files and merged entries of those entities and update palm.yaml and
 * the lock. Something already absent is an `i` line (with the name it nearly is, or the scope it
 * is installed in) and exit 0; a file the user changed keeps the entity (exit 1, the hint is the
 * command with every flag that applies). Files another entry owns, or that lie inside a declared
 * source, stay, and the line says so (E18, K18, C3).
 */
import { isPalmError, PalmError } from '../core/errors.js';
import type {
  EntityRefSpec,
  InstallFailure,
  InstallOutcome,
  KeptFile,
  LockEntry,
  PalmContext,
  RemoveResult,
  Scope,
} from '../core/types.js';
import type { ScopeState } from '../create/engine.js';
import { plural } from '../lib/text.js';
import { failureCount, printInstallSummary } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation, interpretRemove, usage } from './grammar.js';
import { formatName, nearest, palmLine, pasteLine, typedOptions } from './hints.js';
import { grammarContext } from './known.js';
import {
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  otherScope,
  scopeOf,
} from './shared.js';

interface RemoveFlags extends GlobalOptions {
  exclude?: boolean;
  /** O25, Q17: every entry of the source, after a y/N question. */
  all?: boolean;
}

/** A remove ref: a name, and the source it is installed from when the command names one. */
type RemoveRef = EntityRefSpec & { source?: string };

function matches(e: { kind: string; name: string }, n: EntityRefSpec): boolean {
  return e.name.toLowerCase() === n.name.toLowerCase() && (!n.kind || n.kind === e.kind);
}

/** Names no lock entry answers to (of the source, when one was named): already absent. */
function absent(names: EntityRefSpec[], state: ScopeState, source?: string): EntityRefSpec[] {
  const from = source ? (state.sources.byName(source)?.name ?? source) : undefined;
  const entries = state.lock.entries.filter((e) => !from || e.source === from);
  return names.filter((n) => !entries.some((e) => matches(e, n)));
}

/** The kept files of a removed entry as one line: who owns them, or which source holds them. */
function keptNote(reason: KeptFile['reason'], by: string, n: number): string {
  return reason === 'owned'
    ? `kept ${plural(n, 'file')}, owned by ${by}`
    : `kept ${plural(n, 'file')} inside source ${by} (palm never deletes inside a source)`;
}

/** One note per owner (or per source) of the entry's kept files, in the order they came. */
function keptNotes(mine: readonly KeptFile[]): string[] {
  const counts = new Map<string, { reason: KeptFile['reason']; by: string; n: number }>();
  for (const k of mine) {
    const by = k.reason === 'owned' ? (k.owner ?? k.source) : k.source;
    const key = `${k.reason} ${by}`;
    const seen = counts.get(key) ?? { reason: k.reason, by, n: 0 };
    counts.set(key, { ...seen, n: seen.n + 1 });
  }
  return [...counts.values()].map((c) => keptNote(c.reason, c.by, c.n));
}

/** A removed entry as a summary row: the files it removed, and a line per owner it kept files for. */
function removedOutcome(entry: LockEntry, kept: readonly KeptFile[]): InstallOutcome {
  const mine = kept.filter(
    (k) => k.kind === entry.kind && k.name === entry.name && k.source === entry.source,
  );
  const stayed = new Set(mine.map((k) => k.file));
  const files = entry.files.filter((f) => !stayed.has(f));
  return { entry: { ...entry, files }, status: 'removed', notes: keptNotes(mine) };
}

/** M2: the plugin of the run's refs that `f`'s entity is a member of, when the run named it. */
function namedPlugin(f: InstallFailure, refs: readonly RemoveRef[], state: ScopeState) {
  const member = state.lock.entries.find(
    (e) => e.kind === f.kind && e.name === f.name && e.source === f.source,
  );
  const via = member?.via?.replace(/^plugin:/, '');
  return via ? refs.find((r) => r.kind === 'plugin' && r.name === via) : undefined;
}

/**
 * V11: a remove hint repeats the flags this run was given, so the next run has them all. M2: a
 * member of a plugin the run removes points back at the plugin, never at the member alone.
 */
function withFlags(f: InstallFailure, flags: RemoveFlags, job: RemoveJob): InstallFailure {
  if (!f.hint?.startsWith('palm remove ')) return f;
  const plugin = namedPlugin(f, job.refs, job.state);
  const hint = plugin
    ? palmLine('remove', [f.source, `plugin:${plugin.name}`, '--force'], job.state.paths.scope)
    : f.hint;
  const missing = [flags.exclude && '--exclude', flags.force && '--force'].filter(
    (x): x is string => Boolean(x) && !hint.includes(x as string),
  );
  return { ...f, hint: missing.length ? `${hint} ${missing.join(' ')}` : hint };
}

interface RemoveJob {
  state: ScopeState;
  refs: RemoveRef[];
}

/**
 * `i gril is not installed` (the engine may have said it already; the writer prints it once),
 * then where it is installed instead, or the name it nearly is, as a command.
 */
async function printAbsent(
  ctx: PalmContext,
  app: App,
  missing: EntityRefSpec[],
  state: ScopeState,
) {
  const scope = state.paths.scope;
  const other = missing.length ? await otherScope(ctx, app, scope) : undefined;
  const flip: Scope = scope === 'global' ? 'project' : 'global';
  for (const n of missing) {
    app.out.info(`${n.name} is not installed`);
    const near = nearest(
      n.name,
      state.lock.entries.map((e) => e.name),
    );
    const entry = state.lock.entries.find((e) => e.name === near);
    if (other?.lock.entries.some((e) => matches(e, n)))
      app.out.hint(
        `  it is installed in the ${flip} scope: ${palmLine('remove', [formatName(n)], flip)}`,
      );
    else if (entry && near?.toLowerCase() !== n.name.toLowerCase())
      app.out.hint(
        `  did you mean ${near}? ${palmLine('remove', [entry.source, `${entry.kind}:${entry.name}`], scope)}`,
      );
  }
}

/**
 * Y19', R4': E_AMBIGUOUS from the engine: one command per entry the name answers to (each
 * owner, each kind), with the options this run was given.
 */
function ambiguous(e: unknown, app: App, job: RemoveJob): unknown {
  if (!isPalmError(e) || e.code !== 'E_AMBIGUOUS') return e;
  const hits = job.state.lock.entries.filter((x) =>
    job.refs.some(
      (r) => matches(x, r) && (!r.source || sourceOf(job.state, r.source) === x.source),
    ),
  );
  if (hits.length < 2) return e;
  const options = typedOptions(app.argv);
  const scope = job.state.paths.scope;
  const lines = hits.map(
    (x) => `  ${pasteLine('remove', [x.source, `${x.kind}:${x.name}`], options, scope)}`,
  );
  return new PalmError(e.code, e.message, lines.join('\n'));
}

function sourceOf(state: ScopeState, query: string): string {
  return state.sources.byName(query)?.name ?? query;
}

/**
 * O25, Q17: `palm remove <source>` alone or with `--all`: every entry installed from it (a
 * plugin as one), after a y/N question (`--yes` without a terminal).
 */
async function wholeSource(
  ctx: PalmContext,
  state: ScopeState,
  source: string,
): Promise<RemoveRef[]> {
  const name = sourceOf(state, source);
  const entries = state.lock.entries.filter((e) => e.source === name && !e.via);
  if (!entries.length)
    throw new PalmError(
      'E_NOT_FOUND',
      `nothing is installed from ${source}`,
      palmLine('get', ['sources'], state.paths.scope),
    );
  const n = entries.length;
  const what = `${n} ${n === 1 ? 'entry' : 'entries'} from ${name}`;
  if (!ctx.flags.yes && !ctx.ui.isInteractive)
    throw new PalmError('E_NON_INTERACTIVE', `removing ${what} needs a yes`, 'confirm it', {
      retryWith: '--yes',
    });
  const yes = ctx.flags.yes || (await ctx.ui.confirm(`Remove ${what} and the source?`, false));
  if (!yes) throw new PalmError('E_CANCELLED', 'cancelled; nothing was removed');
  return entries.map((e) => ({ kind: e.kind, name: e.name, source: name }));
}

/** A lone word that palm.yaml declares as a source and no entry is named: the whole source. */
function bareSource(state: ScopeState, source: string | undefined, names: EntityRefSpec[]) {
  if (source) return names.length ? undefined : source;
  const [only] = names;
  if (!only || names.length > 1 || only.kind) return undefined;
  const taken = state.lock.entries.some((e) => e.name.toLowerCase() === only.name.toLowerCase());
  return !taken && state.sources.byName(only.name) ? only.name : undefined;
}

async function refsOf(ctx: PalmContext, app: App, inv: Invocation, state: ScopeState) {
  const flags = inv.opts as RemoveFlags;
  const words = inv.words ?? [];
  const gctx = await grammarContext(ctx, app, state, words);
  const { source, names, legacy } = interpretRemove(words, gctx);
  if (legacy) app.out.info(`${legacy.form} is now: ${legacy.replacement}`);
  const whole = bareSource(state, source, names) ?? (flags.all ? source : undefined);
  if (whole) return { names: [], refs: await wholeSource(ctx, state, whole) };
  if (!names.length) throw usage('name what to remove', palmLine('get', [], state.paths.scope));
  return { names, source, refs: names.map((n) => (source ? { ...n, source } : n)) };
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as RemoveFlags;
  const ctx = await makeContext(app, flags);
  const api = engine(app);
  const scope = scopeOf(flags);
  const state = await api.openScope(ctx, scope, { readOnly: true });
  const { names, source, refs } = await refsOf(ctx, app, inv, state);
  const job = { state, refs };
  const opts = { scope, exclude: Boolean(flags.exclude) };
  const result: RemoveResult = await api
    .removeEntities(ctx, refs, opts, engineDeps(app))
    .catch((e: unknown) => {
      throw ambiguous(e, app, job);
    });
  const missing = absent(names, state, source);
  if (app.out.jsonMode) app.out.json({ ...result, absent: missing.map(formatName) });
  else {
    const outcomes = result.removed.map((e) => removedOutcome(e, result.kept ?? []));
    const failures = result.failures.map((f) => withFlags(f, flags, job));
    const summary = { outcomes, failures, warnings: result.warnings };
    const view = { scope, targets: state.targets, dryRun: ctx.flags.dryRun };
    printInstallSummary(app.out, summary, view);
    await printAbsent(ctx, app, missing, state);
  }
  if (failureCount(result)) throw new ExitSignal(1);
}
