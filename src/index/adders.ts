/**
 * Per-kind adders: parse one file (or skill directory) into an entity and register it. Shared by
 * every scan rule; the rules decide which files to hand in and for which plugin.
 */

import { basename, join } from 'node:path';
import { messageOf } from '../core/errors.js';
import type { AgentDefinition, Entity } from '../core/types.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { type ParsedAgent, parseAgentFileDetailed } from './agents.js';
import { parseCommandFile } from './commands.js';
import { hasHooks, parseHooksJson } from './hooks.js';
import { parseInstructionFile } from './instructions.js';
import { parseMcpJson } from './mcp.js';
import type { PluginContext, ScanContext } from './scan-context.js';
import { type ParsedSkill, parseSkillMdDetailed } from './skills.js';
import { asString, baseOf, dirOf, displayRel, joinRel, toSlug } from './util.js';

interface Head {
  name: string;
  description?: string;
  /** The entity's own version; the plugin's and the tag's are the fallbacks. */
  version?: string;
  path: string;
}

/** A new entity with the fields every kind shares. */
export function makeEntity(
  ctx: ScanContext,
  head: Head,
  plugin: PluginContext | undefined,
  def: Entity['def'],
): Entity {
  return withoutUndefined({
    kind: def.kind,
    name: head.name,
    description: head.description,
    version: ctx.versionOf(head.version, plugin),
    path: head.path,
    origin: ctx.alias,
    plugin: plugin?.name,
    def,
  });
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

export function parseSkill(ctx: ScanContext, dirRel: string): Promise<ParsedSkill | null> {
  let p = ctx.skillCache.get(dirRel);
  if (!p) {
    p = parseSkillUncached(ctx, dirRel);
    ctx.skillCache.set(dirRel, p);
  }
  return p;
}

function isTemplateSkill(parsed: ParsedSkill, dirRel: string): boolean {
  return parsed.def.name === 'template-skill' || (dirRel !== '' && baseOf(dirRel) === 'template');
}

async function parseSkillUncached(ctx: ScanContext, dirRel: string): Promise<ParsedSkill | null> {
  const file = joinRel(dirRel, 'SKILL.md');
  const text = await ctx.read(file);
  if (text === undefined) {
    ctx.warnings.push(`skipped ${file}: cannot read file`);
    return null;
  }
  const dirName = dirRel === '' ? basename(ctx.rootAbs) : baseOf(dirRel);
  let parsed: ParsedSkill;
  try {
    parsed = parseSkillMdDetailed(dirName, text, { nameFrom: ctx.layout?.nameFrom });
  } catch (e) {
    ctx.warnings.push(`skipped ${file}: ${messageOf(e)}`);
    return null;
  }
  if (isTemplateSkill(parsed, dirRel)) {
    ctx.warnings.push(`skipped ${file}: skill template`);
    return null;
  }
  for (const issue of parsed.issues) {
    if (dirRel === '' && issue.code === 'name-mismatch') continue;
    ctx.warnings.push(`${file}: ${issue.message}`);
  }
  return parsed;
}

export async function addSkill(
  ctx: ScanContext,
  dirRel: string,
  plugin?: PluginContext,
): Promise<Entity | undefined> {
  // A symlinked alias of an already indexed skill: reuse it without re-parsing (and re-warning).
  const sameFile = ctx.registry.skillAt(dirRel);
  if (sameFile) {
    ctx.registry.claim('skill', displayRel(dirRel));
    return sameFile;
  }
  const parsed = await parseSkill(ctx, dirRel);
  if (!parsed) return undefined;
  const parentDir = ctx.files.parentSkillDir(dirRel);
  const parent = parentDir !== undefined ? (await parseSkill(ctx, parentDir))?.def.name : undefined;
  const skill = withoutUndefined({ ...parsed.def, parent });
  const head = {
    name: skill.name,
    description: skill.description || undefined,
    version: skill.version,
    path: displayRel(dirRel),
  };
  return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'skill', skill }));
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/** An agent file found by convention (not declared) must look like one. */
function acceptsUndeclaredAgent(rel: string, parsed: ParsedAgent): boolean {
  const lower = rel.toLowerCase();
  const def = parsed.def;
  if (lower.endsWith('.agent.md')) return def.description !== '';
  if (lower.endsWith('.toml')) return def.body !== '' || def.description !== '';
  return parsed.hasFrontmatter && parsed.declaredName !== undefined && def.description !== '';
}

/** Source format from the origin-relative location (the absolute path may contain `.apm` itself). */
function agentSourceFormat(
  rel: string,
  def: AgentDefinition,
  plugin: PluginContext | undefined,
): AgentDefinition['sourceFormat'] {
  const lower = rel.toLowerCase();
  if (!lower.endsWith('.md')) return def.sourceFormat;
  if (rel.startsWith('.apm/')) return 'apm-agent-md';
  if (lower.endsWith('.agent.md') || lower.endsWith('.chatmode.md')) return 'copilot-agent-md';
  if (plugin?.format === 'cursor') return 'cursor-md';
  return def.sourceFormat === 'apm-agent-md' ? 'claude-md' : def.sourceFormat;
}

async function parseAgentAt(
  ctx: ScanContext,
  rel: string,
  declared: boolean,
): Promise<ParsedAgent | undefined> {
  const text = await ctx.read(rel);
  if (text === undefined) {
    if (declared) ctx.warnings.push(`skipped ${rel}: cannot read file`);
    return undefined;
  }
  try {
    return parseAgentFileDetailed(join(ctx.rootAbs, rel), text);
  } catch (e) {
    ctx.warnings.push(`skipped ${rel}: ${messageOf(e)}`);
    return undefined;
  }
}

/** `declared`: named by a manifest or descriptor (no frontmatter requirements). */
export async function addAgent(
  ctx: ScanContext,
  rel: string,
  plugin: PluginContext | undefined,
  declared: boolean,
): Promise<Entity | undefined> {
  ctx.registry.claim('agent', rel);
  const parsed = await parseAgentAt(ctx, rel, declared);
  if (!parsed) return undefined;
  if (!declared && !acceptsUndeclaredAgent(rel, parsed)) {
    if (parsed.hasFrontmatter)
      ctx.warnings.push(`skipped ${rel}: agent file without name/description frontmatter`);
    return undefined;
  }
  const def = parsed.def;
  const sourceFormat = agentSourceFormat(rel, def, plugin);
  if (sourceFormat !== undefined) def.sourceFormat = sourceFormat;
  for (const issue of parsed.issues) ctx.warnings.push(`${rel}: ${issue}`);
  const version =
    asString(isRecord(def.extra?.metadata) ? def.extra.metadata.version : undefined) ??
    asString(def.extra?.version);
  const head = { name: def.name, description: def.description || undefined, version, path: rel };
  return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'agent', agent: def }));
}

// ---------------------------------------------------------------------------
// commands and instructions
// ---------------------------------------------------------------------------

export async function addCommand(
  ctx: ScanContext,
  rel: string,
  plugin: PluginContext | undefined,
): Promise<Entity | undefined> {
  ctx.registry.claim('command', rel);
  const text = await ctx.read(rel);
  if (text === undefined) return undefined;
  let def: ReturnType<typeof parseCommandFile>;
  try {
    def = parseCommandFile(join(ctx.rootAbs, rel), text);
  } catch (e) {
    ctx.warnings.push(`skipped ${rel}: ${messageOf(e)}`);
    return undefined;
  }
  if (def.body.trim() === '') {
    ctx.warnings.push(`skipped ${rel}: empty command`);
    return undefined;
  }
  const head = { name: def.name, description: def.description, path: rel };
  return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'command', command: def }));
}

export async function addInstruction(
  ctx: ScanContext,
  rel: string,
  plugin: PluginContext | undefined,
): Promise<Entity | undefined> {
  ctx.registry.claim('instruction', rel);
  const text = await ctx.read(rel);
  if (text === undefined) return undefined;
  const def = parseInstructionFile(join(ctx.rootAbs, rel), text);
  if (def.body.trim() === '') {
    ctx.warnings.push(`skipped ${rel}: empty instruction`);
    return undefined;
  }
  const head = { name: def.name, description: def.description, path: rel };
  return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'instruction', instruction: def }));
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
  const version = ctx.versionOf(undefined, plugin);
  return parseMcpJson(json).map((cfg) => {
    const mcp = {
      ...cfg,
      source: withoutUndefined({ type: 'origin' as const, ref: ctx.alias, version }),
    };
    const head = { name: cfg.name, path: pathRel };
    return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'mcp', mcp }));
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
      name: toSlug(owner === '' ? undefined : baseOf(owner), ctx.alias),
      pluginRootRel: displayRel(owner),
    };
  }
  if (file === 'hooks.json' && baseOf(dirOf(dir)) === 'hooks') {
    return { name: toSlug(baseOf(dir), ctx.alias), pluginRootRel: dir };
  }
  const stem = file.replace(/\.json$/i, '');
  return {
    name: toSlug(stem === 'hooks' ? baseOf(dir) : stem, ctx.alias),
    pluginRootRel: displayRel(dir),
  };
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
  const head = { name: set.name, path: rel };
  return ctx.registry.add(makeEntity(ctx, head, plugin, { kind: 'hook', hooks: set }));
}
