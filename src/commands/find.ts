/**
 * `palm find <path>`: which installed entity wrote a file. Searches the project and global
 * lockfiles (only the global one with -g). Exit 1 when no entry owns the path, 2 when there
 * is no lockfile to search.
 */
import { PalmError } from '../core/errors.js';
import { isHomeAsProject } from '../core/paths.js';
import type { Scope } from '../core/types.js';
import type { FileOwner } from '../engine/find.js';
import { plural } from '../lib/text.js';
import type { App } from './app.js';
import { fileTargetLabel } from './describe.js';
import { type Invocation, usage } from './grammar.js';
import { type GlobalOptions, makeContext } from './shared.js';

const MATCH_TEXT: Record<FileOwner['match'], (o: FileOwner) => string> = {
  file: () => '',
  inside: () => ' (in)',
  merged: () => ' (merged into)',
  contains: (o) => ` (${plural(o.files ?? 0, 'file')} under it)`,
};

function ownerRow(o: FileOwner): string[] {
  const file = o.pointer ? `${o.file} ${o.pointer}` : o.file;
  const how = MATCH_TEXT[o.match](o);
  return [
    o.scope,
    o.entry.kind,
    o.entry.name,
    o.entry.origin,
    fileTargetLabel(o.file),
    `${file}${how}`,
  ];
}

function notFound(query: string, searched: Scope[]): PalmError {
  return new PalmError(
    'E_NOT_FOUND',
    `no installed entity wrote ${query} (searched the ${searched.join(' and ')} lockfile${searched.length > 1 ? 's' : ''})`,
    'list what an entity wrote: palm describe <kind> <name>',
  );
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const [query, ...extra] = inv.names;
  if (!query || extra.length)
    throw usage('name one file to look up', 'palm find <path>   e.g. palm find .claude/skills/tdd');
  const g = inv.opts as GlobalOptions;
  const ctx = await makeContext(app, g, { interactive: false });
  const onlyGlobal = g.global || isHomeAsProject(ctx.paths, ctx.env);
  const scopes: Scope[] = onlyGlobal ? ['global'] : ['project', 'global'];
  const { findFileOwners } = await import('../engine/find.js');
  const { owners, searched } = await findFileOwners(ctx, query, { scopes });
  if (!owners.length) throw notFound(query, searched);
  if (app.out.jsonMode) return app.out.json(owners);
  app.out.table(owners.map(ownerRow), ['scope', 'kind', 'name', 'origin', 'target', 'file']);
}
