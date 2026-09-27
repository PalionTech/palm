import type { Command } from 'commander';
import pc from 'picocolors';
import type { InstallResult, Kind, TargetId } from '../core/types.js';
import { printInstallSummary } from '../ui/output.js';
import { makeContext, printJson, scopeOf, splitKindArgs, splitNameOrigin, withSpinner, type GlobalOptions } from './shared.js';

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .alias('up')
    .summary('refetch origins and reinstall changed entities')
    .description('Refetch origins and reinstall entries whose content changed. With no names, updates everything in the scope; --dry-run shows the plan.')
    .argument('[kind]', 'restrict to one kind (plurals ok)')
    .argument('[names...]', 'names to update (default: all of the kind, or everything)')
    .action(async (kind: string | undefined, names: string[], _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const split = splitKindArgs([...(kind === undefined ? [] : [kind]), ...names]);
      const scope = scopeOf(g);
      const ctx = await makeContext(g);

      let refs: Array<{ kind?: Kind; name: string }> = split.rest.map((n) => ({ kind: split.kind, name: splitNameOrigin(n).name }));
      if (refs.length === 0 && split.kind) {
        // `palm update skills` = every directly installed skill in the scope.
        const { listInstalled } = await import('../engine/query.js');
        refs = (await listInstalled(ctx, scope, split.kind)).filter((e) => !e.via).map((e) => ({ kind: e.kind, name: e.name }));
        if (refs.length === 0) {
          console.log(pc.dim(`No ${split.kind} entries installed in the ${scope} scope.`));
          return;
        }
      }

      const { updateEntities } = await import('../engine/update.js');
      const result: InstallResult = await withSpinner(ctx, g, ctx.flags.dryRun ? 'Planning update' : 'Updating', () => updateEntities(ctx, refs, { scope }));
      if (g.json) return printJson(result);
      const targets = [...new Set(result.outcomes.flatMap((o) => o.entry.targets))] as TargetId[];
      if (ctx.flags.dryRun) console.log(pc.bold('Update plan') + pc.dim(' (dry run: nothing written)'));
      printInstallSummary(result, { scope, targets });
    });
}
