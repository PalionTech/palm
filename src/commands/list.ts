import type { Command } from 'commander';
import pc from 'picocolors';
import { pluralize } from '../core/kinds.js';
import type { LockEntry, OriginIndex } from '../core/types.js';
import { printTable, truncate } from '../ui/output.js';
import { makeContext, printJson, requireKind, scopeOf, shortSha, withSpinner, type GlobalOptions } from './shared.js';

interface ListOptions extends GlobalOptions {
  available?: boolean;
}

export function lockVersion(e: LockEntry): string {
  if (e.ref && e.sha) return `${e.ref} ${pc.dim(`(${shortSha(e.sha)})`)}`;
  return e.ref ?? shortSha(e.sha);
}

export function registerList(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .summary('list installed (or --available) entities')
    .description('List what is installed in the current scope (from the lockfile), or with --available everything your origins offer.')
    .argument('[kind]', 'restrict to one kind (plurals ok)')
    .option('--available', 'list entities in the origin indexes instead of installed ones')
    .action(async (kindArg: string | undefined, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<ListOptions>();
      const kind = kindArg === undefined ? undefined : requireKind(kindArg);
      const scope = scopeOf(o);
      const ctx = await makeContext(o);

      if (o.available) {
        const { getAllIndexes } = await import('../core/cache.js');
        const indexes: OriginIndex[] = await withSpinner(ctx, o, 'Reading origin indexes', () => getAllIndexes(ctx));
        const groups = indexes.map((ix) => ({
          origin: ix.origin,
          entities: ix.entities.filter((e) => !kind || e.kind === kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
        }));
        if (o.json) return printJson(groups);
        const nonEmpty = groups.filter((gr) => gr.entities.length > 0);
        if (nonEmpty.length === 0) {
          console.log(pc.dim(`No ${kind ? pluralize(kind, 2) : 'entities'} available.`) + pc.dim(' Add an origin with `palm origin add owner/repo`.'));
          return;
        }
        nonEmpty.forEach((gr, i) => {
          if (i > 0) console.log('');
          console.log(`${pc.bold(gr.origin)} ${pc.dim(`(${gr.entities.length})`)}`);
          printTable(
            gr.entities.map((e) => [e.kind, e.name, e.version ?? '', truncate(e.description, 70)]),
            ['kind', 'name', 'version', 'description'],
          );
        });
        return;
      }

      const { listInstalled } = await import('../engine/query.js');
      const entries = (await listInstalled(ctx, scope, kind)).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      if (o.json) return printJson(entries);
      if (entries.length === 0) {
        console.log(pc.dim(`No ${kind ? pluralize(kind, 2) : 'entities'} installed in the ${scope} scope.`));
        return;
      }
      printTable(
        entries.map((e) => [e.kind, e.name, e.origin, lockVersion(e), e.targets.join(','), e.via ?? '']),
        ['kind', 'name', 'origin', 'version', 'targets', 'via'],
      );
    });
}
