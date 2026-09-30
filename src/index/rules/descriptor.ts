/**
 * Rule 1 (DESIGN §5): a layout descriptor on the source replaces detection. Its globs are matched
 * against the file index (walked with the descriptor's own ignore rules), not the disk again.
 */

import type { LayoutDescriptor } from '../../core/types.js';
import { addAgent, addCommandAsSkill, addInstruction, addSkill } from '../adders.js';
import { addHookFile, addMcpFile } from '../exec-adders.js';
import { byDepthThenPath } from '../files.js';
import { globIndex } from '../glob.js';
import { minimalIgnoreGlobs } from '../ignore.js';
import type { ScanContext } from '../scan-context.js';
import { baseOf, dirOf, normRel } from '../util.js';

type Globs = string | string[] | undefined;

/** Matches of one descriptor key (directories end with `/`), shallowest first. */
async function globLayout(ctx: ScanContext, layout: LayoutDescriptor, v: Globs): Promise<string[]> {
  const patterns = (Array.isArray(v) ? v : [v ?? ''])
    .map((p) => normRel(p))
    .filter((p) => p !== '');
  if (patterns.length === 0) return [];
  const matches = await globIndex(ctx.files, patterns, {
    ...ctx.globOptions('', minimalIgnoreGlobs(layout.exclude ?? [])),
    onlyFiles: false,
    markDirectories: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    unique: true,
  });
  return matches.sort(byDepthThenPath);
}

/** Files one pattern matches (directories left out). */
async function patternFiles(
  ctx: ScanContext,
  layout: LayoutDescriptor,
  p: string,
): Promise<string[]> {
  return (await globLayout(ctx, layout, p)).filter((m) => !m.endsWith('/'));
}

/** Skill directories one pattern matches: matched SKILL.md files and directories holding one. */
async function patternSkillDirs(
  ctx: ScanContext,
  layout: LayoutDescriptor,
  p: string,
): Promise<string[]> {
  const dirs: string[] = [];
  for (const m of await globLayout(ctx, layout, p)) {
    const rel = m.replace(/\/$/, '');
    if (baseOf(rel) === 'SKILL.md') dirs.push(dirOf(rel));
    else if (ctx.files.isSkillDir(rel)) dirs.push(rel);
  }
  return dirs;
}

type KindKey = 'skills' | 'agents' | 'commands' | 'instructions' | 'hooks' | 'mcp';

/**
 * What one layout key names, shallowest first; a pattern that names nothing is a warning
 * (`layout agents: "people/*.md" matches nothing in the source`, ruling K2).
 */
async function layoutMatches(
  ctx: ScanContext,
  layout: LayoutDescriptor,
  key: KindKey,
): Promise<string[]> {
  const v = layout[key];
  const patterns = (Array.isArray(v) ? v : [v ?? '']).filter((p) => normRel(p) !== '');
  const out: string[] = [];
  for (const p of patterns) {
    const found =
      key === 'skills'
        ? await patternSkillDirs(ctx, layout, p)
        : await patternFiles(ctx, layout, p);
    if (found.length === 0)
      ctx.warnings.push(`layout ${key}: "${p}" matches nothing in the source`);
    out.push(...found);
  }
  return [...new Set(out)].sort(byDepthThenPath);
}

export async function scanDescriptor(ctx: ScanContext, layout: LayoutDescriptor): Promise<void> {
  const files = (key: KindKey) => layoutMatches(ctx, layout, key);
  for (const d of await files('skills')) await addSkill(ctx, d);
  for (const f of await files('agents')) await addAgent(ctx, f, undefined, true);
  for (const f of await files('commands')) await addCommandAsSkill(ctx, f, undefined);
  for (const f of await files('instructions')) await addInstruction(ctx, f, undefined);
  for (const f of await files('hooks')) await addHookFile(ctx, f, undefined);
  for (const f of await files('mcp')) await addMcpFile(ctx, f, undefined, true);
}
