/**
 * `palm update [kind] [names...]` (alias `up`): refetch origins and reinstall entries whose
 * content changed; `palm update origins [alias...]` refreshes origin indexes.
 */
import pc from 'picocolors';
import type { InstallResult, Kind, PalmContext, Scope, TargetId } from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { printInstallSummary } from '../ui/output.js';
import type { App } from './app.js';
import type { Invocation } from './grammar.js';
import { updateOrigins } from './origin.js';
import {
  ExitSignal,
  entityKind,
  failureCount,
  type GlobalOptions,
  makeContext,
  scopeOf,
  withSpinner,
} from './shared.js';

type Ref = { kind?: Kind; name: string };

/** `palm update skills` = every directly installed skill in the scope. */
async function directEntries(ctx: PalmContext, scope: Scope, kind: Kind): Promise<Ref[]> {
  const { listInstalled } = await import('../engine/query.js');
  return (await listInstalled(ctx, scope, kind))
    .filter((e) => !e.via)
    .map((e) => ({ kind: e.kind, name: e.name }));
}

export async function run(inv: Invocation, app: App): Promise<void> {
  if (inv.resource === 'origin') return updateOrigins(inv, app);
  const g = inv.opts as GlobalOptions;
  const kind = entityKind(inv.resource, 'update');
  const scope = scopeOf(g);
  const ctx = await makeContext(app, g);
  const out = app.out;
  let refs: Ref[] = inv.names.map((n) => ({ kind, name: DepRef.parse(n).name }));
  if (refs.length === 0 && kind) {
    refs = await directEntries(ctx, scope, kind);
    if (refs.length === 0) {
      out.hint(`No ${kind} entries installed in the ${scope} scope.`);
      if (out.jsonMode) out.json({ outcomes: [], warnings: [] });
      return;
    }
  }
  const { updateEntities } = await import('../engine/update.js');
  const step = { message: ctx.flags.dryRun ? 'Planning update' : 'Updating', json: out.jsonMode };
  const result: InstallResult = await withSpinner(ctx, step, () =>
    updateEntities(ctx, refs, { scope }, app.deps),
  );
  if (out.jsonMode) out.json(result);
  else {
    const targets = [...new Set(result.outcomes.flatMap((o) => o.entry.targets))] as TargetId[];
    if (ctx.flags.dryRun) out.out(pc.bold('Update plan') + pc.dim(' (dry run: nothing written)'));
    printInstallSummary(out, result, { scope, targets });
  }
  if (failureCount(result)) throw new ExitSignal(1);
}
