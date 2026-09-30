/**
 * Adders for the executable kinds, hook sets and MCP servers: parse, then resolve every reference
 * their commands make to the source and list the closure a deploy copies (DESIGN §2
 * "Relocation"). An unresolvable reference becomes a critical issue on the entity.
 */

import type { Closure, Entity, EntityIssue, SourceReference } from '../core/types.js';
import { makeEntity } from './adders.js';
import { hasHooks, type ParsedHookSet, parseHooksJson } from './hooks.js';
import { addIssues } from './issues.js';
import { filledHeaderNote, fillInHeaders, parseMcpJson } from './mcp.js';
import { collectReferences, namedPaths, normalizeClosure, unresolvedIssues } from './references.js';
import type { PluginContext, ScanContext } from './scan-context.js';
import { baseOf, dirOf, displayRel, normRel, toSlug } from './util.js';

interface RelocationInput {
  site: 'hook' | 'mcp';
  raw: unknown;
  /** The file the definition came from (named in issues). */
  file: string;
  /** Where relative paths start when there is no plugin root (APM layouts). */
  hooksDirRel: string;
  pluginRootRel?: string;
  /** Directories copied whole: the hook files' own directories (none for MCP servers). */
  closureDirs: string[];
}

interface Relocation {
  references: SourceReference[];
  closure: Closure;
  issues: EntityIssue[];
}

function relocation(ctx: ScanContext, input: RelocationInput): Relocation {
  const found = collectReferences(input.raw, input.site, {
    hooksDirRel: input.hooksDirRel,
    pluginRootRel: input.pluginRootRel,
    files: ctx.files,
  });
  const references = found.map((f) => f.ref);
  const paths = normalizeClosure([...input.closureDirs, ...namedPaths(references)], ctx.files);
  return { references, closure: { paths }, issues: unresolvedIssues(found, input.file) };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** One entity per server in an MCP JSON document (`pathRel`: the file it came from). */
export function addMcpConfigs(
  ctx: ScanContext,
  json: unknown,
  pathRel: string,
  plugin: PluginContext | undefined,
): Entity[] {
  return parseMcpJson(json).map((parsed) => {
    const { cfg, filled } = fillInHeaders(parsed);
    for (const f of filled) ctx.warnings.push(filledHeaderNote(cfg.name, f));
    const { references, closure, issues } = relocation(ctx, {
      site: 'mcp',
      raw: cfg,
      file: pathRel,
      hooksDirRel: dirOf(pathRel),
      pluginRootRel: plugin ? plugin.rootRel : dirOf(pathRel),
      closureDirs: [],
    });
    const mcp = { ...cfg, from: { type: 'source' as const, ref: ctx.sourceName } };
    const def = { kind: 'mcp' as const, mcp, references, closure };
    const entity = makeEntity(ctx, { name: cfg.name, path: pathRel }, plugin, def);
    addIssues(entity, issues);
    return ctx.registry.add(entity);
  });
}

/** `declared`: named by a manifest or descriptor (an empty file is worth a warning). */
export async function addMcpFile(
  ctx: ScanContext,
  rel: string,
  plugin: PluginContext | undefined,
  declared: boolean,
): Promise<Entity[]> {
  ctx.registry.claim('mcp', rel);
  const { json, error } = await ctx.readJson(rel);
  if (error) {
    ctx.warnings.push(`skipped ${rel}: ${error}`);
    return [];
  }
  const found = addMcpConfigs(ctx, json, rel, plugin);
  if (found.length === 0 && declared) ctx.warnings.push(`${rel}: no MCP servers found`);
  return found;
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

/** Hook set name + plugin root for a standalone hooks file. */
function hookIdentity(ctx: ScanContext, rel: string): { name: string; pluginRootRel: string } {
  const dir = dirOf(rel);
  const file = baseOf(rel);
  if (file === 'hooks.json' && baseOf(dir) === 'hooks') {
    const owner = dirOf(dir);
    return {
      name: toSlug(owner === '' ? undefined : baseOf(owner), ctx.fallbackName),
      pluginRootRel: displayRel(owner),
    };
  }
  if (file === 'hooks.json' && baseOf(dirOf(dir)) === 'hooks') {
    return { name: toSlug(baseOf(dir), ctx.fallbackName), pluginRootRel: dir };
  }
  const stem = file.replace(/\.json$/i, '');
  return {
    name: toSlug(stem === 'hooks' ? baseOf(dir) : stem, ctx.fallbackName),
    pluginRootRel: displayRel(dir),
  };
}

/**
 * The directories copied whole for a hook set: each hook file's own directory, unless it is the
 * source root or the root of the plugin the set belongs to (a closure is never the whole source
 * or plugin; a standalone `hooks/<name>/hooks.json` keeps its directory).
 */
function hookDirs(files: readonly string[], plugin: PluginContext | undefined): string[] {
  const pluginRoot = plugin ? normRel(plugin.rootRel) : undefined;
  return [...new Set(files.map(dirOf))].filter((d) => d !== '' && d !== pluginRoot);
}

export interface HookEntityInput {
  /** The first hook file (the entity's path). */
  path: string;
  /** Every hook file merged into the set. */
  files: string[];
  plugin?: PluginContext;
  /** APM layouts: relative paths start at the hooks file's directory, not the plugin root. */
  relativeToHooks: boolean;
}

/** A parsed hook set completed with its references and closure; issues go on the entity. */
export function hookEntity(ctx: ScanContext, set: ParsedHookSet, input: HookEntityInput): Entity {
  const pluginRootRel = set.pluginRootRel ?? displayRel(dirOf(input.path));
  const { references, closure, issues } = relocation(ctx, {
    site: 'hook',
    raw: set.raw,
    file: input.path,
    hooksDirRel: dirOf(input.path),
    pluginRootRel: input.relativeToHooks ? undefined : pluginRootRel,
    closureDirs: hookDirs(input.files, input.plugin),
  });
  const def = { kind: 'hook' as const, hooks: { ...set, references, closure } };
  const entity = makeEntity(ctx, { name: set.name, path: input.path }, input.plugin, def);
  addIssues(entity, issues);
  return entity;
}

export async function addHookFile(
  ctx: ScanContext,
  rel: string,
  plugin: PluginContext | undefined,
  nameOverride?: string,
): Promise<Entity | undefined> {
  ctx.registry.claim('hook', rel);
  const { json, error } = await ctx.readJson(rel);
  if (error) {
    ctx.warnings.push(`skipped ${rel}: ${error}`);
    return undefined;
  }
  if (!hasHooks(json)) return undefined;
  const id = hookIdentity(ctx, rel);
  const rootRel = plugin ? displayRel(plugin.rootRel) : id.pluginRootRel;
  const set = parseHooksJson(nameOverride ?? plugin?.name ?? id.name, json, rootRel);
  if (set.dialect === 'unknown') ctx.warnings.push(`${rel}: unrecognised hooks dialect`);
  const input = { path: rel, files: [rel], plugin, relativeToHooks: plugin?.format === 'apm' };
  return ctx.registry.add(hookEntity(ctx, set, input));
}
