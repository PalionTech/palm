/**
 * What an auto-detected scan left out, each with the layout that would index it (rulings K2,
 * B13): files shaped like agents, hook sets or MCP configs outside the places the convention
 * scans (`2 agent-shaped files not indexed: people/*.md; add layout: { … }`), and a SKILL.md
 * under an ignored directory name (`skipped skills/test/SKILL.md (ignored name "test"; …)`).
 *
 * A layout replaces detection, so the suggested layout lists every kind the scan found as well
 * as the missed files: pasted into palm.yaml, it indexes what was found plus what was missed.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entity } from '../core/types.js';
import {
  ALWAYS_SKIP_DIRS,
  isDocFile,
  isScanIgnoredRel,
  SCAN_IGNORE_DIRS,
} from '../domain/ignore.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { isRecord } from '../lib/object.js';
import { isCommandSkill } from './entity-registry.js';
import type { ScanContext } from './scan-context.js';
import { asString, baseOf, dirOf, joinRel } from './util.js';

type LayoutKey = 'skills' | 'agents' | 'commands' | 'instructions' | 'hooks' | 'mcp';
type MissKey = Extract<LayoutKey, 'agents' | 'hooks' | 'mcp'>;

const SHAPE: Record<MissKey, string> = {
  agents: 'agent-shaped',
  hooks: 'hook-shaped',
  mcp: 'MCP-shaped',
};

/** Frontmatter keys only an agent file has (beside `name` and `description`). */
const AGENT_KEYS = ['tools', 'model', 'skills', 'color', 'mcpServers', 'disallowedTools'];

/** Directories that hold a repository's own harness setup or plugin manifests, never a miss. */
const SETUP_DIRS = new Set([
  '.claude',
  '.cursor',
  '.codex',
  '.gemini',
  '.github',
  '.vscode',
  '.opencode',
  '.agents',
  '.apm',
  '.claude-plugin',
  '.cursor-plugin',
  '.codex-plugin',
]);

/** Manifests that carry inline hooks or servers for their plugin (read by the plugin rules). */
const MANIFEST_FILES = new Set([
  'plugin.json',
  'marketplace.json',
  'package.json',
  'gemini-extension.json',
]);

const LAYOUT_ORDER: readonly LayoutKey[] = [
  'skills',
  'agents',
  'commands',
  'instructions',
  'hooks',
  'mcp',
];

function isCandidate(ctx: ScanContext, rel: string): boolean {
  if (ctx.registry.isClaimedAny(rel) || ctx.files.insideSkillDir(rel)) return false;
  if (isScanIgnoredRel(rel) || isDocFile(baseOf(rel)) || MANIFEST_FILES.has(baseOf(rel)))
    return false;
  return !rel.split('/').some((segment) => SETUP_DIRS.has(segment));
}

async function isAgentShaped(ctx: ScanContext, rel: string): Promise<boolean> {
  const text = await ctx.read(rel);
  if (!text?.startsWith('---')) return false;
  try {
    const { data } = parseFrontmatter(text);
    if (asString(data.name) === undefined || asString(data.description) === undefined) return false;
    return AGENT_KEYS.some((k) => data[k] !== undefined);
  } catch {
    return false;
  }
}

async function jsonShape(ctx: ScanContext, rel: string): Promise<MissKey | undefined> {
  const { json } = await ctx.readJson(rel);
  if (!isRecord(json)) return undefined;
  if (isRecord(json.mcpServers) && Object.keys(json.mcpServers).length > 0) return 'mcp';
  const hooks = json.hooks;
  if (isRecord(hooks) && Object.values(hooks).some(Array.isArray)) return 'hooks';
  return undefined;
}

/**
 * True when `rel` sits where the convention scan looks for `key` already (an `agents/` or
 * `hooks/` folder): the scan saw it and passed it over (a dialect twin, a file without the
 * frontmatter an agent needs), so it is no near miss.
 */
function inScannedDir(rel: string, key: MissKey): boolean {
  const dirs = dirOf(rel).split('/');
  if (key === 'agents') return dirs.slice(-3).includes('agents');
  return key === 'hooks' && dirs.slice(-2).includes('hooks');
}

async function shapeOf(ctx: ScanContext, rel: string): Promise<MissKey | undefined> {
  const lower = rel.toLowerCase();
  let key: MissKey | undefined;
  if (lower.endsWith('.md')) key = (await isAgentShaped(ctx, rel)) ? 'agents' : undefined;
  else if (lower.endsWith('.json')) key = await jsonShape(ctx, rel);
  return key && !inScannedDir(rel, key) ? key : undefined;
}

function extOf(rel: string): string {
  const base = baseOf(rel).toLowerCase();
  for (const ext of ['.agent.md', '.instructions.md', '.prompt.md'])
    if (base.endsWith(ext)) return ext;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/**
 * Globs naming exactly `files`: `dir/*.md` when every indexed `.md` file of `dir` is among them,
 * else the paths themselves.
 */
function globsFor(ctx: ScanContext, files: readonly string[]): string[] {
  const groups = new Map<string, { dir: string; ext: string; files: string[] }>();
  for (const f of files) {
    const at = { dir: dirOf(f), ext: extOf(f) };
    const id = `${at.dir}\0${at.ext}`;
    const group = groups.get(id) ?? { ...at, files: [] };
    group.files.push(f);
    groups.set(id, group);
  }
  const out: string[] = [];
  for (const g of groups.values()) {
    const siblings = ctx.files.filesIn(g.dir).filter((f) => extOf(f) === g.ext);
    const whole = g.files.length > 1 && siblings.every((f) => g.files.includes(f));
    out.push(...(whole ? [joinRel(g.dir, `*${g.ext}`)] : g.files));
  }
  return [...new Set(out)].sort();
}

const KEY_OF_KIND: Record<'agent' | 'instruction' | 'hook' | 'mcp', LayoutKey> = {
  agent: 'agents',
  instruction: 'instructions',
  hook: 'hooks',
  mcp: 'mcp',
};

/** The layout key an indexed entity is found under. */
function keyOf(e: Entity): LayoutKey | undefined {
  if (e.kind === 'plugin') return undefined;
  if (e.kind === 'skill') return isCommandSkill(e) ? 'commands' : 'skills';
  return KEY_OF_KIND[e.kind];
}

/** Globs for what the scan indexed: skill directories by parent (`packages/*`), files by folder. */
function foundLayout(ctx: ScanContext): Map<LayoutKey, string[]> {
  const paths = new Map<LayoutKey, string[]>();
  for (const e of ctx.registry.entities) {
    const k = keyOf(e);
    if (k) paths.set(k, [...(paths.get(k) ?? []), e.path]);
  }
  const out = new Map<LayoutKey, string[]>();
  for (const [k, list] of paths) {
    const unique = [...new Set(list)];
    if (k !== 'skills') out.set(k, globsFor(ctx, unique));
    else
      out.set(
        k,
        [...new Set(unique.map((p) => (p === '.' ? '.' : joinRel(dirOf(p), '*'))))].sort(),
      );
  }
  return out;
}

type Globs = Partial<Record<LayoutKey, string[]>>;

/** `{ skills: [packages/*], agents: [people/*.md] }`, keys in a fixed order. */
function formatLayout(layout: Globs): string {
  const parts = LAYOUT_ORDER.filter((k) => (layout[k]?.length ?? 0) > 0).map(
    (k) => `${k}: [${(layout[k] ?? []).join(', ')}]`,
  );
  return `{ ${parts.join(', ')} }`;
}

/** Near-miss lines for the scan's unindexed agent-, hook- and MCP-shaped files. */
export async function warnNearMisses(ctx: ScanContext): Promise<void> {
  if (ctx.descriptorMode) return;
  const missed = new Map<MissKey, string[]>();
  for (const rel of ctx.files.files.filter((f) => isCandidate(ctx, f))) {
    const key = await shapeOf(ctx, rel);
    if (key) missed.set(key, [...(missed.get(key) ?? []), rel]);
  }
  if (missed.size === 0) return;
  const layout: Globs = Object.fromEntries(foundLayout(ctx));
  const lines: string[] = [];
  const keys = [...missed.keys()].sort((a, b) => LAYOUT_ORDER.indexOf(a) - LAYOUT_ORDER.indexOf(b));
  for (const key of keys) {
    const files = missed.get(key) ?? [];
    const globs = globsFor(ctx, files);
    layout[key] = [...new Set([...(layout[key] ?? []), ...globs])].sort();
    const noun = files.length === 1 ? 'file' : 'files';
    lines.push(`${files.length} ${SHAPE[key]} ${noun} not indexed: ${globs.join(', ')}`);
  }
  const add = `add layout: ${formatLayout(layout)}`;
  for (const line of lines) ctx.warnings.push(`${line}; ${add}`);
}

/** Names an auto-detected scan never enters, beside `.git` and `node_modules`. */
const IGNORED_NAMES = SCAN_IGNORE_DIRS.filter((d) => !ALWAYS_SKIP_DIRS.includes(d));

async function isFile(abs: string): Promise<boolean> {
  return stat(abs).then(
    (st) => st.isFile(),
    () => false,
  );
}

/** Directories whose children are skills: `skills/` at the root and every parent of a skill. */
function skillParents(ctx: ScanContext): string[] {
  const parents = new Set<string>(['skills']);
  for (const d of ctx.files.allSkillDirs()) if (d !== '') parents.add(dirOf(d));
  return [...parents].sort();
}

/** SKILL.md files directly below an ignored name inside a skill parent (`skills/test/SKILL.md`). */
async function skippedSkillFiles(ctx: ScanContext): Promise<Array<[rel: string, name: string]>> {
  const out: Array<[string, string]> = [];
  for (const parent of skillParents(ctx)) {
    if (isScanIgnoredRel(parent)) continue;
    for (const name of IGNORED_NAMES) {
      const rel = joinRel(parent, name, 'SKILL.md');
      if (await isFile(join(ctx.rootAbs, rel))) out.push([rel, name]);
    }
  }
  return out;
}

/**
 * `skipped skills/test/SKILL.md (ignored name "test"; add layout: { skills: [skills/*] })`: the
 * layout keeps everything else the scan found, plus the skipped skill's folder.
 */
export async function warnSkippedSkills(ctx: ScanContext): Promise<void> {
  if (ctx.descriptorMode || ctx.files.isSkillDir('')) return;
  for (const [rel, name] of await skippedSkillFiles(ctx)) {
    const layout: Globs = Object.fromEntries(foundLayout(ctx));
    const parentGlob = joinRel(dirOf(dirOf(rel)), '*');
    layout.skills = [...new Set([...(layout.skills ?? []), parentGlob])].sort();
    ctx.warnings.push(
      `skipped ${rel} (ignored name "${name}"; add layout: ${formatLayout(layout)})`,
    );
  }
}
