/**
 * `palm remove [source] <[kind:]name…>` (aliases `uninstall`, `rm`), DESIGN.md §6 "Remove":
 * delete exactly the lock's files and merged entries of those entities and update palm.yaml and
 * the lock. Something already absent is an `i` line (with the name it nearly is, or the scope it
 * is installed in) and exit 0; a file the user changed keeps the entity (exit 1, the hint is the
 * command with every flag that applies). Files another entry owns, or that lie inside a declared
 * source, stay, and the line says so (E18, K18, C3).
 */
import type {
  EntityRefSpec,
  InstallFailure,
  InstallOutcome,
  KeptFiles,
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
import { formatName, nearest, palmLine } from './hints.js';
import { grammarContext } from './known.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface RemoveFlags extends GlobalOptions {
  exclude?: boolean;
}

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
function keptNote(k: KeptFiles): string {
  const n = plural(k.files.length, 'file');
  return k.reason === 'owned'
    ? `kept ${n}, owned by ${k.by}`
    : `kept ${n} inside source ${k.by} (palm never deletes inside a source)`;
}

/** A removed entry as a summary row: the files it removed, and a line per group it kept. */
function removedOutcome(entry: LockEntry, kept: readonly KeptFiles[]): InstallOutcome {
  const mine = kept.filter(
    (k) =>
      k.entry.kind === entry.kind && k.entry.name === entry.name && k.entry.source === entry.source,
  );
  const stayed = new Set(mine.flatMap((k) => k.files));
  const files = entry.files.filter((f) => !stayed.has(f));
  return { entry: { ...entry, files }, status: 'removed', notes: mine.map(keptNote) };
}

/** V11: a remove hint repeats the flags this run was given, so the next run has them all. */
function withFlags(f: InstallFailure, flags: RemoveFlags): InstallFailure {
  if (!f.hint?.startsWith('palm remove ')) return f;
  const missing = [flags.exclude && '--exclude', flags.force && '--force'].filter(
    (x): x is string => Boolean(x) && !f.hint?.includes(x as string),
  );
  return missing.length ? { ...f, hint: `${f.hint} ${missing.join(' ')}` } : f;
}

/** The other scope's lock, to say where an absent name is installed; undefined when it cannot open. */
async function otherScope(ctx: PalmContext, app: App, scope: Scope) {
  const other: Scope = scope === 'global' ? 'project' : 'global';
  return engine(app)
    .openScope(ctx, other, { readOnly: true })
    .catch(() => undefined);
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
    if (other?.lock.entries.some((e) => matches(e, n)))
      app.out.hint(
        `  it is installed in the ${flip} scope: ${palmLine('remove', [formatName(n)], flip)}`,
      );
    else if (near && near.toLowerCase() !== n.name.toLowerCase())
      app.out.hint(`  did you mean ${near}? ${palmLine('remove', [near], scope)}`);
  }
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as RemoveFlags;
  const ctx = await makeContext(app, flags);
  const api = engine(app);
  const scope = scopeOf(flags);
  const state = await api.openScope(ctx, scope, { readOnly: true });
  const words = inv.words ?? [];
  const { source, names, legacy } = interpretRemove(
    words,
    await grammarContext(ctx, app, state, words),
  );
  if (legacy) app.out.info(`${legacy.form} is now: ${legacy.replacement}`);
  if (!names.length)
    throw usage(
      `name what to remove${source ? ` from ${source}` : ''}`,
      palmLine('get', source ? ['--source', source] : [], scope),
    );
  const refs = names.map((n) => (source ? { ...n, source } : n));
  const opts = { scope, exclude: Boolean(flags.exclude) };
  const result: RemoveResult = await api.removeEntities(ctx, refs, opts, engineDeps(app));
  const missing = absent(names, state, source);
  if (app.out.jsonMode) app.out.json({ ...result, absent: missing.map(formatName) });
  else {
    const outcomes = result.removed.map((e) => removedOutcome(e, result.kept ?? []));
    const failures = result.failures.map((f) => withFlags(f, flags));
    const summary = { outcomes, failures, warnings: result.warnings };
    const view = { scope, targets: state.targets, dryRun: ctx.flags.dryRun };
    printInstallSummary(app.out, summary, view);
    await printAbsent(ctx, app, missing, state);
  }
  if (failureCount(result)) throw new ExitSignal(1);
}
