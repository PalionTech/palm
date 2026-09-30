/**
 * `palm remove [source] <[kind:]name…>` (aliases `uninstall`, `rm`), DESIGN.md §6 "Remove":
 * delete exactly the lock's files and merged entries of those entities and update palm.yaml and
 * the lock. Something already absent is an `i` line and exit 0; a file the user changed keeps
 * the entity (exit 1, the hint is the `--force` command).
 */
import type { EntityRefSpec, InstallOutcome, LockEntry, RemoveResult } from '../core/types.js';
import type { ScopeState } from '../create/engine.js';
import { failureCount, printInstallSummary } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, formatName, type Invocation, interpretRemove, usage } from './grammar.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface RemoveFlags extends GlobalOptions {
  exclude?: boolean;
}

/** The first word is a source when palm.yaml declares it and names follow it. */
function selection(
  words: string[],
  state: ScopeState,
): { source?: string; names: EntityRefSpec[] } {
  const w = interpretRemove(words);
  const [first, ...rest] = w.names;
  if (w.source || !first || first.kind || !rest.length) return w;
  return state.sources.byName(first.name) ? { source: first.name, names: rest } : w;
}

function matches(e: { kind: string; name: string }, n: EntityRefSpec): boolean {
  return e.name.toLowerCase() === n.name.toLowerCase() && (!n.kind || n.kind === e.kind);
}

/** Names neither removed nor failed: already absent. */
function absent(names: EntityRefSpec[], result: RemoveResult): EntityRefSpec[] {
  return names.filter(
    (n) =>
      !result.removed.some((e) => matches(e, n)) && !result.failures.some((f) => matches(f, n)),
  );
}

const asOutcome = (entry: LockEntry): InstallOutcome => ({ entry, status: 'removed', notes: [] });

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as RemoveFlags;
  const ctx = await makeContext(app, flags);
  const api = engine(app);
  const scope = scopeOf(flags);
  const state = await api.openScope(ctx, scope, { readOnly: true });
  const { source, names } = selection(inv.words ?? [], state);
  if (!names.length)
    throw usage(
      `name what to remove${source ? ` from ${source}` : ''}`,
      `palm get${source ? ` --source ${source}` : ''}`,
    );
  const refs = names.map((n) => (source ? { ...n, source } : n));
  const result = await api.removeEntities(
    ctx,
    refs,
    { scope, exclude: Boolean(flags.exclude) },
    engineDeps(app),
  );
  const missing = absent(names, result);
  if (app.out.jsonMode) app.out.json({ ...result, absent: missing.map(formatName) });
  else {
    const outcomes = result.removed.map(asOutcome);
    const summary = { outcomes, failures: result.failures, warnings: result.warnings };
    printInstallSummary(app.out, summary, {
      scope,
      targets: state.targets,
      dryRun: ctx.flags.dryRun,
    });
    for (const n of missing) app.out.info(`${formatName(n)} is not installed`);
  }
  if (failureCount(result)) throw new ExitSignal(1);
}
