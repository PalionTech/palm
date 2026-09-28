/**
 * Rule 1 (DESIGN §5): a layout descriptor on the origin replaces detection. Its globs are matched
 * against the file index (walked with the descriptor's own ignore rules), not the disk again.
 */

import type { LayoutDescriptor } from '../../core/types.js';
import {
  addAgent,
  addCommand,
  addHookFile,
  addInstruction,
  addMcpFile,
  addSkill,
} from '../adders.js';
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

async function layoutFiles(
  ctx: ScanContext,
  layout: LayoutDescriptor,
  v: Globs,
): Promise<string[]> {
  return (await globLayout(ctx, layout, v)).filter((m) => !m.endsWith('/'));
}

/** Skill directories: matched SKILL.md files and matched directories that hold one. */
async function layoutSkillDirs(ctx: ScanContext, layout: LayoutDescriptor): Promise<string[]> {
  const dirs: string[] = [];
  for (const m of await globLayout(ctx, layout, layout.skills)) {
    const p = m.replace(/\/$/, '');
    if (baseOf(p) === 'SKILL.md') dirs.push(dirOf(p));
    else if (ctx.files.isSkillDir(p)) dirs.push(p);
  }
  return [...new Set(dirs)].sort(byDepthThenPath);
}

export async function scanDescriptor(ctx: ScanContext, layout: LayoutDescriptor): Promise<void> {
  for (const d of await layoutSkillDirs(ctx, layout)) await addSkill(ctx, d);
  const files = (v: Globs) => layoutFiles(ctx, layout, v);
  for (const f of await files(layout.agents)) await addAgent(ctx, f, undefined, true);
  for (const f of await files(layout.commands)) await addCommand(ctx, f, undefined);
  for (const f of await files(layout.instructions)) await addInstruction(ctx, f, undefined);
  for (const f of await files(layout.hooks)) await addHookFile(ctx, f, undefined);
  for (const f of await files(layout.mcp)) await addMcpFile(ctx, f, undefined, true);
}
