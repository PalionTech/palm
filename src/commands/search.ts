/**
 * `palm search [kind] <query...>`: fuzzy search over every origin index; without a kind or
 * origin, or with the mcp kind, the MCP registry is searched too.
 */
import pc from 'picocolors';
import { messageOf } from '../core/errors.js';
import { parseKind } from '../core/kinds.js';
import type { Entity, Kind, PalmContext, RegistryCandidate } from '../core/types.js';
import { type Output, truncate } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { entityKind, type GlobalOptions, makeContext, withSpinner } from './shared.js';

interface SearchOptions extends GlobalOptions {
  kind?: string;
  origin?: string;
  refresh?: boolean;
}

type Hit = { entity: Entity; score: number };

export function installHint(e: Pick<Entity, 'kind' | 'name' | 'origin'>): string {
  return `palm install ${e.kind} ${e.name}@${e.origin}`;
}

async function searchRegistry(ctx: PalmContext, query: string): Promise<RegistryCandidate[]> {
  try {
    const { searchRegistry: search } = await import('../mcp/registry.js');
    return await search(query, { registryUrl: ctx.config.mcpRegistryUrl, limit: 10 });
  } catch (e) {
    ctx.log.warn(`MCP registry search failed: ${messageOf(e)}`);
    return [];
  }
}

function printHits(out: Output, hits: Hit[]): void {
  if (hits.length === 0) {
    out.hint('No matches in your origins.');
    return;
  }
  const shown = hits.slice(0, 40);
  out.table(
    shown.map(({ entity: e }) => [
      e.kind,
      e.name,
      e.origin,
      e.version ?? '',
      truncate(e.description, 60),
    ]),
    ['kind', 'name', 'origin', 'version', 'description'],
  );
  if (hits.length > shown.length)
    out.hint(`… ${hits.length - shown.length} more; narrow with a kind or -o <origin>`);
  const first = shown[0]?.entity;
  if (first) out.hint(`\ninstall with: ${installHint(first)}`);
}

function printRegistry(out: Output, registry: RegistryCandidate[]): void {
  if (registry.length === 0) return;
  out.out(`\n${pc.bold('MCP registry')}`);
  out.table(
    registry.map((c) => [c.name, c.version ?? '', c.config.transport, truncate(c.description, 60)]),
    ['name', 'version', 'transport', 'description'],
  );
  out.hint(`\ninstall with: palm install mcp ${registry[0]?.name ?? '<name>'}`);
}

function kindOf(inv: Invocation, o: SearchOptions): Kind | undefined {
  const fromWord = entityKind(inv.resource, 'search');
  if (!o.kind) return fromWord;
  const flag = parseKind(o.kind);
  if (!flag) throw usage(`"${o.kind}" is not a kind`, 'palm search skill <query>');
  return flag;
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const o = inv.opts as SearchOptions;
  const query = inv.names.join(' ').trim();
  if (!query)
    throw usage('name what to search for', 'palm search tdd   or   palm search skill review');
  const kind = kindOf(inv, o);
  const ctx = await makeContext(app, o);
  let origin: string | undefined;
  if (o.origin) {
    origin = ctx.origins.resolveQuery(o.origin).spec.alias;
  }
  const { searchIndex } = await import('../engine/query.js');
  const hits: Hit[] = await withSpinner(
    ctx,
    { message: `Searching for "${query}"`, json: o.json },
    () => searchIndex(ctx, query, { kind, origin, refresh: Boolean(o.refresh) }),
  );
  const wantRegistry = (!kind || kind === 'mcp') && !origin && !ctx.flags.offline;
  const registry = wantRegistry ? await searchRegistry(ctx, query) : [];
  const out = app.out;
  if (out.jsonMode)
    return out.json({ index: hits.map((h) => ({ ...h.entity, score: h.score })), registry });
  if (hits.length === 0 && registry.length === 0) {
    out.hint(`No matches for "${query}".`);
    out.hint(
      'Add more origins with: palm install origin owner/repo   (or search again with --refresh)',
    );
    return;
  }
  printHits(out, hits);
  printRegistry(out, registry);
}
