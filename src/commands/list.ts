import type { Command } from 'commander';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import type { Entity, Kind, LockEntry, OriginIndex, OriginSpec } from '../core/types.js';
import { printTable, truncate } from '../ui/output.js';
import { makeContext, printJson, requireKind, scopeOf, shortSha, withSpinner, type GlobalOptions } from './shared.js';

interface ListOptions extends GlobalOptions {
  available?: boolean;
  origin?: string;
}

/** `-o` values of the installed view for entries that came from palm's own pseudo-origins. */
export const PSEUDO_ORIGINS = ['mine', 'registry', 'adhoc'] as const;

export function lockVersion(e: LockEntry): string {
  if (e.ref && e.sha) return `${e.ref} ${pc.dim(`(${shortSha(e.sha)})`)}`;
  return e.ref ?? shortSha(e.sha);
}

const byKindName = (a: { kind: string; name: string }, b: { kind: string; name: string }): number =>
  a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);

/** Installed entries of one kind and/or one origin alias (the lock's `origin`), sorted by kind and name. */
export function filterInstalled(entries: LockEntry[], opts: { kind?: Kind; origin?: string } = {}): LockEntry[] {
  const origin = opts.origin?.toLowerCase();
  return entries.filter((e) => (!opts.kind || e.kind === opts.kind) && (!origin || e.origin.toLowerCase() === origin)).sort(byKindName);
}

/**
 * The lock alias `-o <query>` selects in the installed view: `mine`, `registry` and `adhoc` as is,
 * else the registered origin `resolve` finds; an origin removed after installing still matches its
 * entries by alias.
 */
export function installedOriginAlias(query: string, entries: LockEntry[], resolve: (query: string) => OriginSpec): string {
  const q = query.trim().toLowerCase();
  if ((PSEUDO_ORIGINS as readonly string[]).includes(q)) return q;
  try {
    return resolve(query).alias;
  } catch (e) {
    if (e instanceof PalmError && e.code === 'E_NOT_FOUND' && entries.some((x) => x.origin.toLowerCase() === q)) return q;
    throw e;
  }
}

export interface AvailableGroup {
  origin: string;
  entities: Entity[];
  duplicates: string[];
}

/** One group per origin index (optionally only `origin`), entities of `kind` sorted by kind and name. */
export function availableGroups(
  indexes: OriginIndex[],
  opts: { kind?: Kind; origin?: string; duplicates?: (ix: OriginIndex, kind?: Kind) => string[] } = {},
): AvailableGroup[] {
  const origin = opts.origin?.toLowerCase();
  return indexes
    .filter((ix) => !origin || ix.origin.toLowerCase() === origin)
    .map((ix) => ({
      origin: ix.origin,
      entities: ix.entities.filter((e) => !opts.kind || e.kind === opts.kind).sort(byKindName),
      duplicates: opts.duplicates ? opts.duplicates(ix, opts.kind) : [],
    }));
}

export function registerList(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .summary('list what is installed (--available: what your origins offer)')
    .description(
      'List what is installed in the current scope (from the lockfile), or with --available everything your origins offer, grouped by origin. ' +
        '-o/--origin narrows either view to one origin.',
    )
    .argument('[kind]', 'restrict to one kind (plurals ok)')
    .option('--available', 'list entities in the origin indexes instead of installed ones')
    .option('-o, --origin <name-or-alias>', 'only this origin: alias, owner/repo[/root], URL or local path (installed view also: mine, registry, adhoc)')
    .action(async (kindArg: string | undefined, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<ListOptions>();
      const kind = kindArg === undefined ? undefined : requireKind(kindArg);
      const scope = scopeOf(o);
      const ctx = await makeContext(o);
      const kinds = kind ? pluralize(kind, 2) : 'entities';

      if (o.available) {
        let only: OriginSpec | undefined;
        let indexes: OriginIndex[];
        if (o.origin) {
          const { resolveOriginQuery } = await import('../core/config.js');
          const spec = resolveOriginQuery(ctx, o.origin);
          only = spec;
          const { getIndex } = await import('../core/cache.js');
          indexes = [await withSpinner(ctx, o, `Reading the ${spec.alias} index`, () => getIndex(ctx, spec))];
        } else {
          const { getAllIndexes } = await import('../core/cache.js');
          indexes = await withSpinner(ctx, o, 'Reading origin indexes', () => getAllIndexes(ctx));
        }
        const { duplicateWarnings } = await import('../engine/query.js');
        const groups = availableGroups(indexes, { kind, origin: only?.alias, duplicates: duplicateWarnings });
        if (o.json) return printJson(groups);
        const nonEmpty = groups.filter((gr) => gr.entities.length > 0);
        if (nonEmpty.length === 0) {
          console.log(
            only
              ? pc.dim(`No ${kinds} available in origin ${only.alias}.`)
              : pc.dim(`No ${kinds} available.`) + pc.dim(' Add an origin with `palm origin add owner/repo`.'),
          );
          return;
        }
        nonEmpty.forEach((gr, i) => {
          if (i > 0) console.log('');
          console.log(`${pc.bold(gr.origin)} ${pc.dim(`(${gr.entities.length})`)}`);
          printTable(
            gr.entities.map((e) => [e.kind, e.name, e.version ?? '', truncate(e.description, 70)]),
            ['kind', 'name', 'version', 'description'],
          );
          for (const w of gr.duplicates) console.log(pc.yellow(`⚠ ${w}`));
        });
        return;
      }

      const { listInstalled } = await import('../engine/query.js');
      const installed = await listInstalled(ctx, scope, kind);
      let origin: string | undefined;
      if (o.origin) {
        const { resolveOriginQuery } = await import('../core/config.js');
        origin = installedOriginAlias(o.origin, installed, (q) => resolveOriginQuery(ctx, q));
      }
      const entries = filterInstalled(installed, { kind, origin });
      if (o.json) return printJson(entries);
      if (entries.length === 0) {
        console.log(pc.dim(`No ${kinds} installed in the ${scope} scope${origin ? ` from origin ${origin}` : ''}.`));
        return;
      }
      printTable(
        entries.map((e) => [e.kind, e.name, e.origin, lockVersion(e), e.targets.join(','), e.via ?? '']),
        ['kind', 'name', 'origin', 'version', 'targets', 'via'],
      );
    });
}
