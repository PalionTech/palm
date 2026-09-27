import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import { KINDS, type Entity, type Kind, type OriginIndex, type OriginSpec, type PalmContext } from '../core/types.js';
import { printTable } from '../ui/output.js';
import { makeContext, printJson, withSpinner, type GlobalOptions } from './shared.js';

interface OriginAddOptions extends GlobalOptions {
  alias?: string;
  ref?: string;
  root?: string;
  project?: boolean;
}

/** "12 skills, 3 agents" for the entities of an index. */
export function kindCounts(entities: Pick<Entity, 'kind'>[]): string {
  const counts = new Map<Kind, number>();
  for (const e of entities) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const parts = KINDS.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${pluralize(k, counts.get(k)!)}`);
  return parts.length ? parts.join(', ') : 'no entities';
}

export function describeLocation(spec: OriginSpec): string {
  const base = spec.type === 'local' ? (spec.path ?? '') : (spec.url ?? '');
  return spec.root ? `${base} ${pc.dim(`/${spec.root}`)}` : base;
}

/** Read `<palmHome>/cache/<originId>.index.json` without fetching (DESIGN.md §5). */
async function readCachedIndex(ctx: PalmContext, spec: OriginSpec): Promise<OriginIndex | undefined> {
  try {
    const { originId } = await import('../core/config.js');
    const text = await readFile(join(ctx.paths.palmHome, 'cache', `${originId(spec)}.index.json`), 'utf8');
    const parsed = JSON.parse(text) as Partial<OriginIndex>;
    return Array.isArray(parsed.entities) ? (parsed as OriginIndex) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For a marketplace.json URL, the raw download URL plus the repo it belongs to.
 * GitHub `blob/<ref>/…` and raw.githubusercontent.com URLs map to `https://github.com/<o>/<r>.git` at `<ref>`.
 */
export function marketplaceUrlBase(url: string): { rawUrl: string; base: { url?: string; ref?: string }; relPath: string } {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'github.com' && parts[2] === 'blob' && parts.length >= 5) {
    const [owner, repo, , ref, ...rest] = parts;
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`,
      base: { url: `https://github.com/${owner}/${repo}.git`, ref },
      relPath: rest.join('/'),
    };
  }
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return { rawUrl: url, base: { url: `https://github.com/${owner}/${repo}.git`, ref }, relPath: rest.join('/') };
  }
  return { rawUrl: url, base: {}, relPath: basename(u.pathname) || 'marketplace.json' };
}

/** Directory a marketplace file's relative sources resolve against. */
export function marketplaceRootDir(file: string): string {
  const dir = dirname(file);
  const parent = basename(dir);
  if (parent === '.claude-plugin' || parent === '.cursor-plugin') return dirname(dir);
  if ((parent === 'plugin' && basename(dirname(dir)) === '.github') || (parent === 'plugins' && basename(dirname(dir)) === '.agents')) {
    return dirname(dirname(dir));
  }
  return dir;
}

async function importMarketplace(ctx: PalmContext, g: OriginAddOptions, input: string): Promise<void> {
  const { parseMarketplace, findMarketplaceFile } = await import('../index/marketplace.js');
  let file: string;
  let base: { url?: string; path?: string; ref?: string };
  let tmp: string | undefined;
  try {
    if (/^https?:\/\//i.test(input)) {
      if (ctx.flags.offline) throw new PalmError('E_NETWORK', 'cannot download a marketplace file with --offline');
      const m = marketplaceUrlBase(input);
      const res = await fetch(m.rawUrl).catch((e: unknown) => {
        throw new PalmError('E_NETWORK', `could not download ${m.rawUrl}: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!res.ok) throw new PalmError('E_NETWORK', `could not download ${m.rawUrl}: HTTP ${res.status}`);
      tmp = await mkdtemp(join(tmpdir(), 'palm-marketplace-'));
      file = join(tmp, m.relPath);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await res.text());
      base = m.base;
    } else {
      const abs = resolve(ctx.paths.cwd, input);
      const st = await stat(abs).catch(() => undefined);
      if (!st) throw new PalmError('E_NOT_FOUND', `no such file or directory: ${abs}`);
      if (st.isDirectory()) {
        const found = await findMarketplaceFile(abs);
        if (!found) throw new PalmError('E_NOT_FOUND', `no marketplace.json under ${abs}`, 'point at the file, e.g. .claude-plugin/marketplace.json');
        file = found;
      } else {
        file = abs;
      }
      base = { path: marketplaceRootDir(file) };
    }

    const { origins, warnings }: { origins: OriginSpec[]; warnings: string[] } = await parseMarketplace(file, base);
    for (const w of warnings) ctx.log.warn(w);
    if (origins.length === 0) {
      ctx.log.warn('the marketplace lists no plugins palm can add');
      return;
    }
    const chosen =
      ctx.ui.isInteractive && !ctx.flags.yes
        ? await ctx.ui.pickMany(
            `Add which of the ${origins.length} marketplace entries as origins?`,
            origins.map((o) => ({ value: o, label: o.alias, hint: [o.url ?? o.path, o.root, o.ref && `#${o.ref}`].filter(Boolean).join(' ') })),
            origins,
          )
        : origins;

    const { addOrigin } = await import('../core/config.js');
    const added: OriginSpec[] = [];
    for (const spec of chosen) {
      if (ctx.flags.dryRun) {
        added.push(spec);
        continue;
      }
      try {
        added.push(await addOrigin(ctx, spec, { scope: g.project ? 'project' : 'global' }));
      } catch (e) {
        ctx.log.warn(`skipped ${spec.alias}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (g.json) return printJson(added);
    printTable(added.map((o) => [o.alias, describeLocation(o), o.ref ?? '']), ['alias', 'location', 'ref']);
    console.log(
      ctx.flags.dryRun
        ? pc.dim('\ndry run: no origins were added')
        : `\n${pc.green('✓')} added ${added.length} origin${added.length === 1 ? '' : 's'}; index them with ${pc.bold('palm origin update')}`,
    );
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

async function indexOne(ctx: PalmContext, g: GlobalOptions, spec: OriginSpec): Promise<OriginIndex> {
  const { getIndex } = await import('../core/cache.js');
  return withSpinner(ctx, g, `Indexing ${spec.alias}`, () => getIndex(ctx, spec, { refresh: true }), (ix) => `${spec.alias}: ${kindCounts(ix.entities)}`);
}

export function registerOrigin(program: Command): void {
  const origin = program.command('origin').summary('manage origins (where entities come from)').description('Manage origins: git repositories or local directories that palm indexes for entities.');

  origin
    .command('add')
    .description('Register an origin and index it.')
    .argument('<spec>', 'owner/repo, owner/repo/sub/dir, github:owner/repo, git URL[#ref], local path, or marketplace.json')
    .option('--alias <alias>', 'short name used in name@alias (default: repo name)')
    .option('--ref <ref>', 'tag, branch or sha (default: latest semver tag, else default branch)')
    .option('--root <path>', 'subdirectory that is the origin root')
    .option('--project', 'save in this project’s palm.yaml instead of the global config')
    .action(async (input: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<OriginAddOptions>();
      const ctx = await makeContext(o);
      if (/marketplace\.json$/i.test(input)) return importMarketplace(ctx, o, input);
      const { parseOriginInput, addOrigin } = await import('../core/config.js');
      const parsed = parseOriginInput(input, { alias: o.alias, ref: o.ref, root: o.root });
      if (ctx.flags.dryRun) {
        console.log(`would add origin ${pc.bold(parsed.alias)} → ${describeLocation(parsed)}`);
        return;
      }
      const spec = await addOrigin(ctx, parsed, { scope: o.project ? 'project' : 'global' });
      if (!o.json) ctx.log.success(`added origin ${pc.bold(spec.alias)} → ${describeLocation(spec)}`);
      if (ctx.flags.offline) {
        if (o.json) printJson({ origin: spec });
        else ctx.log.info(pc.dim('offline: not indexed; run `palm origin update` later'));
        return;
      }
      let index: OriginIndex;
      try {
        index = await indexOne(ctx, o, spec);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new PalmError('E_ORIGIN', `origin "${spec.alias}" was added but could not be indexed: ${msg}`, `retry with \`palm origin update ${spec.alias}\` or undo with \`palm origin remove ${spec.alias}\``);
      }
      if (o.json) return printJson({ origin: spec, counts: countMap(index.entities), warnings: index.warnings });
      console.log(`${pc.bold(spec.alias)}: ${kindCounts(index.entities)} ${pc.dim(`(${index.detected})`)}`);
      for (const w of index.warnings) ctx.log.warn(w);
      const example = index.entities[0];
      if (example) console.log(`\n${pc.dim('install with:')} palm install ${example.kind} ${example.name}@${spec.alias}`);
    });

  origin
    .command('list')
    .alias('ls')
    .description('List registered origins (global config and this project’s palm.yaml).')
    .action(async (_opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = await makeContext(o);
      const { allOrigins } = await import('../core/config.js');
      const specs = allOrigins(ctx);
      const globalAliases = new Set(ctx.config.origins.map((s) => s.alias));
      const rows = await Promise.all(specs.map(async (spec) => ({ spec, index: await readCachedIndex(ctx, spec) })));
      if (o.json) {
        return printJson(
          rows.map(({ spec, index }) => ({
            ...spec,
            scope: globalAliases.has(spec.alias) ? 'global' : 'project',
            indexed: index ? { counts: countMap(index.entities), sha: index.sha, detected: index.detected, warnings: index.warnings, scannedAt: index.scannedAt } : null,
          })),
        );
      }
      if (rows.length === 0) {
        console.log(pc.dim('No origins yet. Add one with `palm origin add owner/repo`.'));
        return;
      }
      printTable(
        rows.map(({ spec, index }) => [
          spec.alias,
          spec.type,
          describeLocation(spec),
          spec.ref ?? (index?.ref ? pc.dim(index.ref) : ''),
          globalAliases.has(spec.alias) ? 'global' : 'project',
          index ? kindCounts(index.entities) : pc.dim('not indexed'),
        ]),
        ['alias', 'type', 'location', 'ref', 'scope', 'indexed'],
      );
      if (o.verbose) {
        for (const { spec, index } of rows) {
          if (!index) continue;
          console.log(`\n${pc.bold(spec.alias)} ${pc.dim(`detected: ${index.detected}${index.sha ? `, sha ${index.sha.slice(0, 7)}` : ''}, scanned ${index.scannedAt}`)}`);
          for (const w of index.warnings) console.log(pc.yellow(`  ⚠ ${w}`));
        }
      }
    });

  origin
    .command('remove')
    .alias('rm')
    .description('Unregister an origin (installed entities stay installed).')
    .argument('<alias>', 'origin alias')
    .action(async (alias: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = await makeContext(o);
      const { removeOrigin } = await import('../core/config.js');
      if (ctx.flags.dryRun) {
        console.log(`would remove origin ${alias}`);
        return;
      }
      await removeOrigin(ctx, alias);
      ctx.log.success(`removed origin ${alias}`);
    });

  origin
    .command('update')
    .description('Refetch and rescan one origin, or all of them.')
    .argument('[alias]', 'origin alias (default: all)')
    .action(async (alias: string | undefined, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = await makeContext(o);
      const { allOrigins, findOrigin } = await import('../core/config.js');
      let specs: OriginSpec[];
      if (alias) {
        const spec = findOrigin(ctx, alias);
        if (!spec) throw new PalmError('E_NOT_FOUND', `no origin named "${alias}"`, 'see `palm origin list`');
        specs = [spec];
      } else {
        specs = allOrigins(ctx);
      }
      if (specs.length === 0) {
        console.log(pc.dim('No origins to update.'));
        return;
      }
      const results: Array<{ alias: string; counts?: Record<string, number>; sha?: string; error?: string }> = [];
      for (const spec of specs) {
        try {
          const index = await indexOne(ctx, o, spec);
          results.push({ alias: spec.alias, counts: countMap(index.entities), sha: index.sha });
          if (!o.json) {
            console.log(`${pc.green('✓')} ${pc.bold(spec.alias)}: ${kindCounts(index.entities)}${index.sha ? pc.dim(` @ ${index.sha.slice(0, 7)}`) : ''}`);
            for (const w of index.warnings) ctx.log.debug(`${spec.alias}: ${w}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ alias: spec.alias, error: msg });
          if (!o.json) ctx.log.warn(`${spec.alias}: ${msg}`);
        }
      }
      if (o.json) printJson(results);
      const failed = results.filter((r) => r.error);
      if (failed.length) throw new PalmError('E_ORIGIN', `${failed.length} of ${results.length} origin${results.length === 1 ? '' : 's'} failed to update: ${failed.map((f) => f.alias).join(', ')}`);
    });

  origin
    .command('import')
    .description('Add the plugins listed in a marketplace.json (file, directory or URL) as origins.')
    .argument('<source>', 'path to marketplace.json, a directory containing one, or an https:// URL')
    .option('--project', 'save in this project’s palm.yaml instead of the global config')
    .action(async (source: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<OriginAddOptions>();
      const ctx = await makeContext(o);
      await importMarketplace(ctx, o, source);
    });
}

function countMap(entities: Pick<Entity, 'kind'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entities) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
