/**
 * A plugin's components: declared skill/agent/command/rule paths and globs resolved against the
 * file index, the default directories used when nothing is declared, and the hook and MCP files
 * a plugin merges into one hook set / its server list.
 */

import type { Entity } from '../core/types.js';
import { isDocFile } from '../domain/ignore.js';
import { parseSkill } from './adders.js';
import { addMcpConfigs, addMcpFile, hookEntity } from './exec-adders.js';
import { byDepthThenPath } from './files.js';
import {
  detectHookDialect,
  hasHooks,
  mergeHooksRaw,
  normalizeHooksJson,
  parseHooksJson,
} from './hooks.js';
import type { ComponentDecls } from './plugin-manifest.js';
import type { PluginContext, ScanContext } from './scan-context.js';
import {
  baseOf,
  dirOf,
  displayRel,
  escapesRoot,
  hasGlobChars,
  joinRel,
  normRel,
  toSlug,
} from './util.js';

/** One plugin being scanned: where it lives and how its entities are attributed. */
export interface PluginScope {
  ctx: ScanContext;
  rootRel: string;
  /** The plugin's name for warnings (also when its members are indexed standalone). */
  name: string;
  plugin: PluginContext;
  /** Manifest (or marketplace) file that inline hooks / MCP servers came from. */
  manifestRel: string;
}

export type ResolveKind = 'agent' | 'command' | 'instruction';

export const EXTENSIONS: Record<ResolveKind, string[]> = {
  agent: ['.md', '.toml'],
  command: ['.md', '.toml'],
  instruction: ['.mdc', '.md'],
};

export function hasExt(rel: string, exts: string[]): boolean {
  const l = rel.toLowerCase();
  return exts.some((e) => l.endsWith(e));
}

// ---------------------------------------------------------------------------
// agents, commands, rules
// ---------------------------------------------------------------------------

/** Files of `kind` in a declared directory (agents: two levels deep); skill contents excluded. */
function expandDir(scope: PluginScope, kind: ResolveKind, dirRel: string): string[] {
  const files = scope.ctx.files;
  const listed = kind === 'agent' ? files.filesUnder(dirRel, 2) : files.filesIn(dirRel);
  return listed.filter(
    (f) =>
      hasExt(f, EXTENSIONS[kind]) &&
      !isDocFile(baseOf(f)) &&
      (dirRel === scope.rootRel || !files.insideSkillDir(f)),
  );
}

async function resolveGlobDecl(
  scope: PluginScope,
  kind: ResolveKind,
  v: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const m of await scope.ctx.globIn(scope.rootRel, v)) {
    const k = await scope.ctx.fsKind(m);
    if (k === 'file' && hasExt(m, EXTENSIONS[kind])) out.push(m);
    else if (k === 'dir') out.push(...expandDir(scope, kind, m));
  }
  return out;
}

/** Plugin-relative first, then source-relative; agents also try the `.agent.md` spelling. */
function declCandidates(rootRel: string, v: string, kind: ResolveKind): string[] {
  const candidates = [joinRel(rootRel, v)];
  if (rootRel !== '') candidates.push(normRel(v));
  if (kind !== 'agent') return candidates;
  const agentMd = candidates
    .filter((c) => c.endsWith('.md') && !c.endsWith('.agent.md'))
    .map((c) => c.replace(/\.md$/, '.agent.md'));
  return [...candidates, ...agentMd];
}

/** Files for one declared path; undefined when nothing exists there. */
async function resolvePathDecl(
  scope: PluginScope,
  kind: ResolveKind,
  v: string,
): Promise<string[] | undefined> {
  for (const c of declCandidates(scope.rootRel, v, kind)) {
    if (escapesRoot(c)) continue;
    const k = await scope.ctx.fsKind(c);
    if (k === 'file') return [c];
    if (k === 'dir') return expandDir(scope, kind, c);
  }
  return undefined;
}

/** Resolve declared file/dir/glob paths of a plugin to source-relative files. */
export async function resolveFiles(
  scope: PluginScope,
  values: string[],
  kind: ResolveKind,
): Promise<string[]> {
  const out: string[] = [];
  for (const v of values) {
    if (hasGlobChars(v)) {
      out.push(...(await resolveGlobDecl(scope, kind, v)));
      continue;
    }
    if (escapesRoot(joinRel(scope.rootRel, v))) {
      scope.ctx.warnings.push(
        `plugin ${scope.name}: path "${v}" points outside the source; ignored`,
      );
      continue;
    }
    const found = await resolvePathDecl(scope, kind, v);
    if (found) out.push(...found);
    else scope.ctx.warnings.push(`plugin ${scope.name}: declared ${kind} path "${v}" not found`);
  }
  return [...new Set(out)];
}

export function defaultAgentFiles(ctx: ScanContext, rootRel: string): string[] {
  return ctx.files
    .filesUnder(joinRel(rootRel, 'agents'), 2)
    .filter(
      (f) => hasExt(f, EXTENSIONS.agent) && !isDocFile(baseOf(f)) && !ctx.files.insideSkillDir(f),
    );
}

export function defaultCommandFiles(ctx: ScanContext, rootRel: string): string[] {
  const commands = ctx.files
    .filesIn(joinRel(rootRel, 'commands'))
    .filter((f) => hasExt(f, EXTENSIONS.command) && !isDocFile(baseOf(f)));
  const prompts = ctx.files
    .filesIn(joinRel(rootRel, 'prompts'))
    .filter((f) => f.endsWith('.prompt.md'));
  // `.md` before `.toml` so Claude commands win over Gemini twins with the same name.
  return [
    ...commands.filter((f) => f.endsWith('.md')),
    ...commands.filter((f) => f.endsWith('.toml')),
    ...prompts,
  ];
}

export function defaultRuleFiles(ctx: ScanContext, rootRel: string): string[] {
  const rules = ctx.files
    .filesIn(joinRel(rootRel, 'rules'))
    .filter((f) => hasExt(f, EXTENSIONS.instruction) && !isDocFile(baseOf(f)));
  const instructions = ctx.files
    .filesIn(joinRel(rootRel, 'instructions'))
    .filter((f) => f.endsWith('.md') && !isDocFile(baseOf(f)));
  return [...rules, ...instructions];
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

async function resolveSkillGlob(ctx: ScanContext, rootRel: string, v: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of await ctx.globIn(rootRel, v)) {
    if (ctx.files.isSkillDir(m)) out.push(m);
    else if (baseOf(m) === 'SKILL.md') out.push(dirOf(m));
    else if (ctx.files.hasDir(m) && m !== '') out.push(...ctx.files.skillDirsBelow(m));
  }
  return [...new Set(out)];
}

/** Some catalogs list skill names rather than paths. */
async function skillDirByName(
  ctx: ScanContext,
  rootRel: string,
  name: string,
): Promise<string | undefined> {
  for (const d of ctx.files.skillDirsWithin(rootRel).sort(byDepthThenPath)) {
    if ((await parseSkill(ctx, d))?.def.name === name) return d;
  }
  return undefined;
}

async function resolveSkillDecl(ctx: ScanContext, rootRel: string, v: string): Promise<string[]> {
  if (hasGlobChars(v)) return resolveSkillGlob(ctx, rootRel, v);
  const candidates = [joinRel(rootRel, v), joinRel(rootRel, 'skills', baseOf(normRel(v)))];
  if (rootRel !== '') candidates.push(normRel(v));
  for (const c of candidates) {
    if (escapesRoot(c)) continue;
    if (ctx.files.isSkillDir(c)) return [c];
    const below = ctx.files.hasDir(c) ? ctx.files.skillDirsBelow(c) : [];
    if (below.length > 0) return below;
  }
  if (normRel(v).includes('/')) return [];
  const byName = await skillDirByName(ctx, rootRel, normRel(v));
  return byName === undefined ? [] : [byName];
}

/**
 * Skill directories of a plugin: `skills/*` plus the declared ones, or exactly the declared ones
 * (`exact`: strict:false marketplace entries and entries sharing the marketplace root).
 */
export async function pluginSkillDirs(
  scope: PluginScope,
  declared: string[] | undefined,
  exact: boolean,
): Promise<string[]> {
  const defaults = scope.ctx.files.childSkillDirs(joinRel(scope.rootRel, 'skills'));
  if (!declared || declared.length === 0) return defaults;
  const resolved: string[] = [];
  for (const v of declared) {
    const dirs = await resolveSkillDecl(scope.ctx, scope.rootRel, v);
    if (dirs.length === 0)
      scope.ctx.warnings.push(`plugin ${scope.name}: declared skill path "${v}" not found`);
    resolved.push(...dirs);
  }
  if (exact) return resolved.length > 0 ? [...new Set(resolved)] : defaults;
  return [...new Set([...defaults, ...resolved])];
}

// ---------------------------------------------------------------------------
// hooks and MCP servers
// ---------------------------------------------------------------------------

/** A declared hooks/MCP file, plugin-relative first, then source-relative. */
async function findDeclaredFile(scope: PluginScope, p: string): Promise<string | undefined> {
  const candidates = [joinRel(scope.rootRel, p)];
  if (scope.rootRel !== '') candidates.push(normRel(p));
  for (const c of candidates) {
    if (!escapesRoot(c) && (await scope.ctx.fsKind(c)) === 'file') return c;
  }
  return undefined;
}

interface HookSource {
  path: string;
  json: unknown;
}

/** Declared hook files, inline manifest hooks and the default `hooks/hooks.json`, in that order. */
async function hookSources(
  scope: PluginScope,
  decl: ComponentDecls['hooks'],
): Promise<HookSource[]> {
  const { ctx, rootRel } = scope;
  const sources: HookSource[] = [];
  const seen = new Set<string>();
  const addFile = async (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    ctx.registry.claim('hook', rel);
    const { json, error } = await ctx.readJson(rel);
    if (error) ctx.warnings.push(`skipped ${rel}: ${error}`);
    else sources.push({ path: rel, json });
  };
  for (const p of decl?.paths ?? []) {
    const found = await findDeclaredFile(scope, p);
    if (found) await addFile(found);
    else ctx.warnings.push(`plugin ${scope.name}: declared hooks path "${p}" not found`);
  }
  for (const inline of decl?.inline ?? []) sources.push({ path: scope.manifestRel, json: inline });
  const defaultFile = joinRel(rootRel, 'hooks/hooks.json');
  // Cursor manifests name their hooks file explicitly; Claude/Codex merge with hooks/hooks.json.
  const useDefault = scope.plugin.format !== 'cursor' || (decl?.paths.length ?? 0) === 0;
  if (useDefault && ctx.files.hasFile(defaultFile)) await addFile(defaultFile);
  return sources.filter((s) => hasHooks(s.json));
}

/** Merge hook sources of the first source's dialect; others are warned about and dropped. */
function mergeHookSources(
  scope: PluginScope,
  usable: HookSource[],
): { raw: unknown; merged: string[] } {
  const [first, ...rest] = usable as [HookSource, ...HookSource[]];
  const primary = detectHookDialect(first.json);
  let raw: unknown = normalizeHooksJson(first.json);
  const merged = [first.path];
  for (const s of rest) {
    const d = detectHookDialect(s.json);
    if (d !== primary) {
      scope.ctx.warnings.push(
        `plugin ${scope.name}: hooks in ${s.path} use the ${d} dialect (primary ${primary}); ignored`,
      );
      continue;
    }
    raw = mergeHooksRaw(raw, s.json);
    if (!merged.includes(s.path)) merged.push(s.path);
  }
  return { raw, merged };
}

/** The plugin's hooks as one hook set named after the plugin. */
export async function addPluginHooks(
  scope: PluginScope,
  decl: ComponentDecls['hooks'],
): Promise<Entity | undefined> {
  const { ctx, rootRel, plugin } = scope;
  const usable = await hookSources(scope, decl);
  const first = usable[0];
  if (!first) return undefined;
  const { raw, merged } = mergeHookSources(scope, usable);
  const name = plugin.name ?? toSlug(baseOf(rootRel), ctx.fallbackName);
  const set = parseHooksJson(name, raw, displayRel(rootRel));
  if (set.dialect === 'unknown') ctx.warnings.push(`${first.path}: unrecognised hooks dialect`);
  const input = { path: first.path, files: merged, plugin, relativeToHooks: false };
  const entity = hookEntity(ctx, set, input);
  if (merged.length > 1) ctx.extraSources.set(entity, merged.slice(1));
  return ctx.registry.add(entity);
}

/** Declared MCP files, inline manifest servers and the default `.mcp.json` / `mcp.json`. */
export async function addPluginMcp(
  scope: PluginScope,
  decl: ComponentDecls['mcpServers'],
): Promise<Entity[]> {
  const { ctx, rootRel, plugin } = scope;
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const p of decl?.paths ?? []) {
    const found = await findDeclaredFile(scope, p);
    if (!found) {
      ctx.warnings.push(`plugin ${scope.name}: declared mcpServers path "${p}" not found`);
      continue;
    }
    if (seen.has(found)) continue;
    seen.add(found);
    out.push(...(await addMcpFile(ctx, found, plugin, true)));
  }
  for (const inline of decl?.inline ?? [])
    out.push(...addMcpConfigs(ctx, inline, scope.manifestRel, plugin));
  for (const f of ['.mcp.json', 'mcp.json']) {
    const rel = joinRel(rootRel, f);
    if (seen.has(rel) || !ctx.files.hasFile(rel)) continue;
    seen.add(rel);
    out.push(...(await addMcpFile(ctx, rel, plugin, false)));
  }
  return out;
}
