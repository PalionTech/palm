/**
 * Rule 2 (DESIGN §5): an APM package (`apm.yml` with `.apm/`). Primitives come from
 * `.apm/{skills,agents,chatmodes,instructions,prompts,commands,hooks}`; the package is a plugin.
 */

import { basename } from 'node:path';
import YAML from 'yaml';
import { messageOf } from '../../core/errors.js';
import { isDocFile } from '../../domain/ignore.js';
import { isRecord, withoutUndefined } from '../../lib/object.js';
import { addAgent, addCommand, addHookFile, addInstruction, addSkill } from '../adders.js';
import { MemberList } from '../entity-registry.js';
import { byDepthThenPath } from '../files.js';
import { EXTENSIONS, hasExt } from '../plugin-components.js';
import type { PluginContext, ScanContext } from '../scan-context.js';
import { asString, baseOf, dirOf, toSlug } from '../util.js';

async function readApmManifest(
  ctx: ScanContext,
  apmFile: string,
): Promise<Record<string, unknown>> {
  const text = await ctx.read(apmFile);
  try {
    const parsed: unknown = text === undefined ? {} : YAML.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch (e) {
    ctx.warnings.push(`${apmFile}: invalid YAML (${messageOf(e).split('\n')[0]})`);
    return {};
  }
}

/** Top-level skills are members; nested sub-skills are indexed standalone. */
async function collectApmSkills(
  ctx: ScanContext,
  pkg: PluginContext,
  members: MemberList,
): Promise<void> {
  const dirs = ctx.files
    .skillDirsWithin('.apm/skills')
    .filter((d) => d !== '.apm/skills')
    .sort(byDepthThenPath);
  for (const d of dirs) {
    const topLevel = ctx.files.parentSkillDir(d) === undefined;
    const e = await addSkill(ctx, d, topLevel ? pkg : undefined);
    if (topLevel) members.add(e);
  }
}

const markdownIn = (ctx: ScanContext, dir: string): string[] =>
  ctx.files.filesIn(dir).filter((f) => f.endsWith('.md') && !isDocFile(baseOf(f)));

async function collectApmFiles(
  ctx: ScanContext,
  pkg: PluginContext,
  members: MemberList,
): Promise<void> {
  const agents = ctx.files
    .filesIn('.apm/agents')
    .filter((x) => hasExt(x, EXTENSIONS.agent) && !isDocFile(baseOf(x)));
  for (const f of agents) members.add(await addAgent(ctx, f, pkg, true));
  for (const f of markdownIn(ctx, '.apm/chatmodes')) members.add(await addAgent(ctx, f, pkg, true));
  for (const f of markdownIn(ctx, '.apm/instructions'))
    members.add(await addInstruction(ctx, f, pkg));
  for (const f of [...markdownIn(ctx, '.apm/prompts'), ...markdownIn(ctx, '.apm/commands')])
    members.add(await addCommand(ctx, f, pkg));
}

/** `hooks.json` takes the package (or its directory's) name; other files their stem. */
function apmHookName(rel: string, pkgName: string): string {
  const stem = baseOf(rel).replace(/\.json$/i, '');
  if (stem !== 'hooks') return toSlug(stem, pkgName);
  return dirOf(rel) === '.apm/hooks' ? pkgName : toSlug(baseOf(dirOf(rel)), pkgName);
}

async function collectApmHooks(
  ctx: ScanContext,
  pkg: PluginContext,
  members: MemberList,
): Promise<void> {
  const name = pkg.name as string;
  for (const f of ctx.files.filesUnder('.apm/hooks', 1).filter((x) => x.endsWith('.json')))
    members.add(await addHookFile(ctx, f, pkg, apmHookName(f, name)));
}

/** Index the APM package. False when `.apm/` holds no primitives (other rules then apply). */
export async function scanApm(ctx: ScanContext, apmFile: string): Promise<boolean> {
  const data = await readApmManifest(ctx, apmFile);
  const name = toSlug(asString(data.name), basename(ctx.rootAbs), ctx.alias);
  const version = asString(data.version);
  const pkg: PluginContext = withoutUndefined({
    name,
    version,
    rootRel: '',
    format: 'apm' as const,
  });
  const members = new MemberList();
  await collectApmSkills(ctx, pkg, members);
  await collectApmFiles(ctx, pkg, members);
  await collectApmHooks(ctx, pkg, members);
  if (members.refs.length === 0) {
    ctx.warnings.push(
      `${apmFile}: APM package has no primitives under .apm/; scanning the repository instead`,
    );
    return false;
  }
  const plugin = withoutUndefined({
    kind: 'plugin' as const,
    name,
    description: asString(data.description),
    version: ctx.versionOf(version, undefined),
    path: '.',
    origin: ctx.alias,
    def: { kind: 'plugin' as const, members: members.refs, manifestPath: apmFile },
  });
  ctx.registry.addPlugin(plugin, '');
  return true;
}
