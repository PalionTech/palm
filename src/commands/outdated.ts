/**
 * `palm outdated [kind]`: current / wanted / latest for every direct install. Informational:
 * always exit 0 (a remote that cannot be read shows `?` and a warning).
 */
import pc from 'picocolors';
import { parseKind } from '../core/kinds.js';
import type { OutdatedItem } from '../engine/outdated.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { type GlobalOptions, makeContext, scopeOf, withSpinner } from './shared.js';

function itemRow(i: OutdatedItem): string[] {
  const wanted = i.status === 'outdated' ? pc.yellow(i.wanted) : i.wanted;
  const latest = i.status === 'pinned' || i.status === 'outdated' ? pc.cyan(i.latest) : i.latest;
  return [i.kind, i.name, i.origin, i.current, wanted, latest];
}

function printItems(out: Output, items: OutdatedItem[], flag: string): void {
  out.table(items.map(itemRow), ['kind', 'name', 'origin', 'current', 'wanted', 'latest']);
  const behind = items.filter((i) => i.status === 'outdated').length;
  const pinned = items.filter((i) => i.status === 'pinned').length;
  if (behind) out.hint(`\n${behind} behind what palm.yaml wants: palm update${flag}`);
  if (pinned)
    out.hint(
      `${pinned} pinned below the latest release: change the #ref in palm.yaml, then palm update${flag}`,
    );
  if (!behind && !pinned) out.hint('\nEverything is at the wanted and the latest ref.');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const [word, ...extra] = inv.names;
  const kind = parseKind(word);
  if ((word !== undefined && !kind) || extra.length)
    throw usage(
      `"${word ?? extra[0]}" is not an entity kind`,
      'palm outdated [kind]   e.g. palm outdated skills',
    );
  const g = inv.opts as GlobalOptions;
  const scope = scopeOf(g);
  const ctx = await makeContext(app, g, { interactive: false });
  const { outdatedEntries } = await import('../engine/outdated.js');
  const step = { message: 'Reading remote refs', json: app.out.jsonMode };
  const report = await withSpinner(ctx, step, () =>
    outdatedEntries(ctx, { scope, kind }, app.deps),
  );
  for (const w of report.warnings) app.out.warn(w);
  if (app.out.jsonMode) return app.out.json(report.items);
  if (!report.items.length) {
    app.out.hint(`Nothing installed in the ${scope} scope${kind ? ` (${kind}s)` : ''}.`);
    return;
  }
  printItems(app.out, report.items, scope === 'global' ? ' -g' : '');
}
