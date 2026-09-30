/**
 * Rule 4 (DESIGN §5): a plugin directory with one manifest (the scanner follows it with a
 * convention pass). `scanPlugin` is also the plugin scan of every other plugin-shaped rule:
 * marketplace entries and nested plugins found by convention.
 */

import { join } from 'node:path';
import type { Entity } from '../../core/types.js';
import { withoutUndefined } from '../../lib/object.js';
import { addAgent, addCommandAsSkill, addInstruction, addSkill } from '../adders.js';
import { MemberList } from '../entity-registry.js';
import { byDepthThenPath } from '../files.js';
import type { MarketplaceEntry } from '../marketplace.js';
import {
  addPluginHooks,
  addPluginMcp,
  defaultAgentFiles,
  defaultCommandFiles,
  defaultRuleFiles,
  type PluginScope,
  pluginSkillDirs,
  resolveFiles,
} from '../plugin-components.js';
import {
  type ComponentDecls,
  findPluginManifest,
  mergeDecls,
  type PluginManifest,
} from '../plugin-manifest.js';
import type { PluginContext, ScanContext } from '../scan-context.js';
import { baseOf, dirDepth, dirOf, displayRel, joinRel, toSlug } from '../util.js';

export interface PluginInput {
  rootRel: string;
  manifest?: PluginManifest;
  entry?: MarketplaceEntry;
  /** Entry source is the marketplace root (`./`): a declared skills list is the complete set. */
  sharedRoot?: boolean;
  marketplaceRel?: string;
}

/** Name, version and declarations of one plugin from its manifest and marketplace entry. */
interface PluginSetup {
  rawName: string;
  name: string;
  version?: string;
  /** `strict: false` entries replace the manifest's declarations. */
  strict: boolean;
  decls: ComponentDecls;
  manifestRel: string;
  /** A plugin of this name exists already: members are indexed standalone. */
  duplicate: boolean;
}

function pluginSetup(ctx: ScanContext, input: PluginInput): PluginSetup {
  const { rootRel, manifest, entry } = input;
  const strict = entry ? entry.strict : true;
  const rawName =
    manifest?.name ?? entry?.name ?? (rootRel === '' ? ctx.fallbackName : baseOf(rootRel));
  const name = toSlug(rawName, baseOf(rootRel), ctx.fallbackName);
  return {
    rawName,
    name,
    version: manifest?.version ?? entry?.version,
    strict,
    decls: strict
      ? mergeDecls(manifest?.components, entry?.components)
      : { ...(entry?.components ?? {}) },
    manifestRel: manifest
      ? joinRel(rootRel, manifest.file)
      : (input.marketplaceRel ?? displayRel(rootRel)),
    duplicate: ctx.registry.hasName('plugin', name),
  };
}

function warnSetup(ctx: ScanContext, input: PluginInput, setup: PluginSetup): void {
  const { manifest, entry } = input;
  const { name, strict } = setup;
  if (name !== setup.rawName)
    ctx.warnings.push(`plugin name "${setup.rawName}" is not a valid slug; using "${name}"`);
  if (!strict && manifest && Object.keys(manifest.components).length > 0) {
    ctx.warnings.push(
      `plugin ${name}: strict:false marketplace entry overrides the components declared in ${setup.manifestRel}`,
    );
  }
  const unsupported = [
    ...new Set([...(strict ? (manifest?.unsupported ?? []) : []), ...(entry?.unsupported ?? [])]),
  ];
  if (unsupported.length > 0)
    ctx.warnings.push(`plugin ${name}: ${unsupported.join(', ')} not supported by palm (ignored)`);
  if (setup.duplicate) {
    ctx.warnings.push(
      `duplicate plugin "${name}" at ${displayRel(input.rootRel)}: its components are indexed standalone`,
    );
  }
}

function pluginScope(ctx: ScanContext, input: PluginInput, setup: PluginSetup): PluginScope {
  const plugin: PluginContext = withoutUndefined({
    name: setup.duplicate ? undefined : setup.name,
    version: setup.version,
    rootRel: input.rootRel,
    format: input.manifest?.format,
  });
  return { ctx, rootRel: input.rootRel, name: setup.name, plugin, manifestRel: setup.manifestRel };
}

async function collectSkills(
  scope: PluginScope,
  decls: ComponentDecls,
  exact: boolean,
  members: MemberList,
): Promise<void> {
  for (const d of await pluginSkillDirs(scope, decls.skills, exact))
    members.add(await addSkill(scope.ctx, d, scope.plugin));
}

async function collectAgents(
  scope: PluginScope,
  decls: ComponentDecls,
  members: MemberList,
): Promise<void> {
  const files = decls.agents
    ? await resolveFiles(scope, decls.agents, 'agent')
    : defaultAgentFiles(scope.ctx, scope.rootRel);
  const declared = decls.agents !== undefined;
  for (const f of files) members.add(await addAgent(scope.ctx, f, scope.plugin, declared));
}

async function collectCommands(
  scope: PluginScope,
  decls: ComponentDecls,
  members: MemberList,
): Promise<void> {
  const files = decls.commands
    ? await resolveFiles(scope, decls.commands, 'command')
    : defaultCommandFiles(scope.ctx, scope.rootRel);
  for (const f of files) members.add(await addCommandAsSkill(scope.ctx, f, scope.plugin));
}

async function collectRules(
  scope: PluginScope,
  decls: ComponentDecls,
  members: MemberList,
): Promise<void> {
  const files = decls.rules
    ? await resolveFiles(scope, decls.rules, 'instruction')
    : defaultRuleFiles(scope.ctx, scope.rootRel);
  for (const f of files) members.add(await addInstruction(scope.ctx, f, scope.plugin));
}

/** Index every component of the plugin, in kind order; returns the plugin's members. */
async function collectMembers(
  scope: PluginScope,
  setup: PluginSetup,
  exactSkills: boolean,
): Promise<MemberList> {
  const members = new MemberList();
  await collectSkills(scope, setup.decls, exactSkills, members);
  await collectAgents(scope, setup.decls, members);
  await collectCommands(scope, setup.decls, members);
  await collectRules(scope, setup.decls, members);
  members.add(await addPluginHooks(scope, setup.decls.hooks));
  members.addAll(await addPluginMcp(scope, setup.decls.mcpServers));
  return members;
}

/** Register the plugin entity itself (unless it has no members or its name is taken). */
function registerPlugin(
  scope: PluginScope,
  input: PluginInput,
  setup: PluginSetup,
  members: MemberList,
): void {
  const { ctx, rootRel } = scope;
  if (members.refs.length === 0) {
    ctx.warnings.push(
      `plugin "${setup.name}" at ${displayRel(rootRel)} has no installable components; skipped`,
    );
    return;
  }
  if (setup.duplicate) return;
  const plugin: Entity = withoutUndefined({
    kind: 'plugin' as const,
    name: setup.name,
    description: input.manifest?.description ?? input.entry?.description,
    version: ctx.versionOf(setup.version, undefined),
    path: displayRel(rootRel),
    source: ctx.sourceName,
    def: withoutUndefined({
      kind: 'plugin' as const,
      members: members.refs,
      manifestPath: input.manifest ? setup.manifestRel : input.marketplaceRel,
    }),
  });
  ctx.registry.addPlugin(plugin, rootRel);
}

/** Scan one plugin directory (manifest and/or marketplace entry) into its members + the plugin. */
export async function scanPlugin(ctx: ScanContext, input: PluginInput): Promise<void> {
  await ctx.ensureIndexed(input.rootRel);
  const setup = pluginSetup(ctx, input);
  warnSetup(ctx, input, setup);
  const scope = pluginScope(ctx, input, setup);
  const exactSkills = !setup.strict || input.sharedRoot === true;
  const members = await collectMembers(scope, setup, exactSkills);
  registerPlugin(scope, input, setup, members);
}

const MANIFEST_DIRS = ['.claude-plugin', '.cursor-plugin', '.codex-plugin'];

/** The plugin directory a manifest file belongs to, if `rel` is one. */
function manifestOwner(rel: string): string | undefined {
  const base = baseOf(rel);
  if (base === 'gemini-extension.json') return dirOf(rel);
  if (base !== 'plugin.json') return undefined;
  return MANIFEST_DIRS.includes(baseOf(dirOf(rel))) ? dirOf(dirOf(rel)) : dirOf(rel);
}

/** Plugin directories below the root that carry their own manifest (convention mode only). */
export async function scanNestedPlugins(ctx: ScanContext): Promise<number> {
  const dirs = new Set<string>();
  for (const f of ctx.files.files) {
    const dir = manifestOwner(f);
    if (dir === undefined || dir === '' || dirDepth(`${dir}/x`) > 3) continue;
    if (!ctx.files.insideSkillDir(`${dir}/x`)) dirs.add(dir);
  }
  let count = 0;
  for (const dir of [...dirs].sort(byDepthThenPath)) {
    const manifest = await findPluginManifest(join(ctx.rootAbs, dir), ctx.warnings, dir);
    if (!manifest) continue;
    const before = ctx.registry.pluginRoots.length;
    await scanPlugin(ctx, { rootRel: dir, manifest });
    if (ctx.registry.pluginRoots.length > before) count++;
  }
  return count;
}
