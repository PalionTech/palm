import type { Command } from 'commander';
import pc from 'picocolors';
import type { Entity, RegistryCandidate } from '../core/types.js';
import { printTable, truncate } from '../ui/output.js';
import { makeContext, printJson, requireKind, withSpinner, type GlobalOptions } from './shared.js';

interface SearchOptions extends GlobalOptions {
  kind?: string;
  origin?: string;
  refresh?: boolean;
}

export function installHint(e: Pick<Entity, 'kind' | 'name' | 'origin'>): string {
  return `palm install ${e.kind} ${e.name}@${e.origin}`;
}

export function registerSearch(program: Command): void {
  program
    .command('search')
    .summary('search origins (and the MCP registry)')
    .description('Fuzzy search across every origin index. Without --kind, or with --kind mcp, the MCP registry is searched too.')
    .argument('<query>', 'words to look for in names and descriptions')
    .option('--kind <kind>', 'restrict to one kind')
    .option('--origin <alias>', 'restrict to one origin')
    .option('--refresh', 'refetch origins before searching')
    .action(async (query: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<SearchOptions>();
      const kind = o.kind ? requireKind(o.kind) : undefined;
      const ctx = await makeContext(o);
      const { searchIndex } = await import('../engine/query.js');
      const hits = await withSpinner(ctx, o, `Searching for "${query}"`, () =>
        searchIndex(ctx, query, { kind, origin: o.origin, refresh: Boolean(o.refresh) }),
      );

      let registry: RegistryCandidate[] = [];
      const wantRegistry = (!kind || kind === 'mcp') && !o.origin && !ctx.flags.offline;
      if (wantRegistry) {
        try {
          const { searchRegistry } = await import('../mcp/registry.js');
          registry = await searchRegistry(query, { registryUrl: ctx.config.mcpRegistryUrl, limit: 10 });
        } catch (e) {
          ctx.log.warn(`MCP registry search failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (o.json) return printJson({ index: hits.map((h) => ({ ...h.entity, score: h.score })), registry });

      if (hits.length === 0 && registry.length === 0) {
        console.log(pc.dim(`No matches for "${query}".`));
        console.log(pc.dim('Add more origins with `palm origin add owner/repo`, or refresh with --refresh.'));
        return;
      }

      if (hits.length) {
        const shown = hits.slice(0, 40);
        printTable(
          shown.map(({ entity: e }) => [e.kind, e.name, e.origin, e.version ?? '', truncate(e.description, 60)]),
          ['kind', 'name', 'origin', 'version', 'description'],
        );
        if (hits.length > shown.length) console.log(pc.dim(`… ${hits.length - shown.length} more; narrow with --kind or --origin`));
        const first = shown[0]!.entity;
        console.log(`\n${pc.dim('install with:')} ${installHint(first)}`);
      } else {
        console.log(pc.dim('No matches in your origins.'));
      }

      if (registry.length) {
        console.log(`\n${pc.bold('MCP registry')}`);
        printTable(
          registry.map((c) => [c.name, c.version ?? '', c.config.transport, truncate(c.description, 60)]),
          ['name', 'version', 'transport', 'description'],
        );
        console.log(`\n${pc.dim('install with:')} palm install mcp ${registry[0]!.name}`);
      }
    });
}
