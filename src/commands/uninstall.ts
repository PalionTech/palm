import type { Command } from 'commander';
import pc from 'picocolors';
import type { LockEntry } from '../core/types.js';
import { printTable } from '../ui/output.js';
import {
  type GlobalOptions,
  makeContext,
  printJson,
  scopeOf,
  splitKindArgs,
  splitNameOrigin,
  usage,
} from './shared.js';

export function registerUninstall(program: Command): void {
  program
    .command('uninstall')
    .aliases(['remove', 'rm'])
    .summary('remove entities and the dependencies nothing else needs')
    .description(
      'Remove installed entities: deletes the files palm wrote, reverses merged config, drops dependencies nothing else needs, and updates palm.yaml.',
    )
    .argument('[kind]', 'restrict to one kind (plurals ok)')
    .argument('[names...]', 'name[@origin]')
    .action(async (kind: string | undefined, names: string[], _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const split = splitKindArgs([...(kind === undefined ? [] : [kind]), ...names]);
      if (split.rest.length === 0)
        throw usage('name at least one entity to uninstall', 'palm uninstall skill wayfinder');
      const refs = split.rest.map((spec) => ({ kind: split.kind, ...splitNameOrigin(spec) }));
      const scope = scopeOf(g);
      const ctx = await makeContext(g);
      const { uninstallEntities } = await import('../engine/uninstall.js');
      const result: { removed: LockEntry[]; warnings: string[] } = await uninstallEntities(
        ctx,
        refs,
        { scope },
      );
      if (g.json) return printJson(result);
      if (result.removed.length === 0) {
        ctx.log.warn(`nothing was removed from the ${scope} scope`);
      } else {
        printTable(
          result.removed.map((e) => [
            e.kind,
            e.name,
            e.origin,
            `${e.files.length} file${e.files.length === 1 ? '' : 's'}${e.merged?.length ? ` +${e.merged.length} merged` : ''}`,
            e.via ?? '',
          ]),
          ['kind', 'name', 'origin', 'removed', 'via'],
        );
      }
      for (const w of result.warnings) ctx.log.warn(w);
      if (g.dryRun) console.log(pc.dim('\ndry run: nothing was removed'));
    });
}
