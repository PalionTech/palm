/**
 * `palm uninstall [kind] <names...>` (aliases `remove`, `rm`, `delete`): delete what palm
 * wrote, reverse merged config, drop dependencies nothing else needs, update palm.yaml. An
 * entity with files the user changed since palm wrote them stays installed (a failure whose
 * hint is the `--force` command); a file or target that cannot be removed is reported; either
 * exits 1. `palm uninstall origin <alias>...` unregisters origins.
 */
import type { Kind, LockEntry } from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { plural } from '../lib/text.js';
import { type Output, printFailures, symbol } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { uninstallOrigin } from './origin.js';
import {
  ExitSignal,
  entityKind,
  failureCount,
  type GlobalOptions,
  makeContext,
  scopeOf,
} from './shared.js';

function removedCell(e: LockEntry): string {
  const files = plural(e.files.length, 'file');
  return e.merged?.length ? `${files} +${e.merged.length} merged` : files;
}

function printRemoved(out: Output, removed: LockEntry[], dryRun: boolean): void {
  const status = `${symbol('removed')} ${dryRun ? 'would remove' : 'removed'}`;
  out.table(
    removed.map((e) => [status, e.kind, e.name, e.origin, removedCell(e), e.via ?? '']),
    ['status', 'kind', 'name', 'origin', 'files', 'via'],
  );
}

function refsOf(inv: Invocation, kind: Kind | undefined) {
  if (inv.names.length === 0)
    throw usage(
      `name at least one ${kind ?? 'entity'} to uninstall`,
      `palm uninstall ${kind ?? 'skill'} <name>   (see what is installed: palm get)`,
    );
  return inv.names.map((spec) => {
    const ref = DepRef.parse(spec);
    return { kind, name: ref.name, ...(ref.origin ? { origin: ref.origin } : {}) };
  });
}

export async function run(inv: Invocation, app: App): Promise<void> {
  if (inv.resource === 'origin') return uninstallOrigin(inv, app);
  const g = inv.opts as GlobalOptions;
  const kind = entityKind(inv.resource, 'uninstall');
  const refs = refsOf(inv, kind);
  const scope = scopeOf(g);
  const ctx = await makeContext(app, g);
  const { uninstallEntities } = await import('../engine/uninstall.js');
  const result = await uninstallEntities(ctx, refs, { scope }, app.deps);
  const out = app.out;
  for (const w of result.warnings) out.warn(w);
  if (out.jsonMode) out.json(result);
  else if (result.removed.length === 0) out.warn(`nothing was removed from the ${scope} scope`);
  else printRemoved(out, result.removed, ctx.flags.dryRun);
  if (ctx.flags.dryRun && !out.jsonMode) out.hint('\ndry run: nothing was removed');
  if (!out.jsonMode) printFailures(out, result.failures);
  if (failureCount(result)) throw new ExitSignal(1);
}
