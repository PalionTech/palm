/**
 * Rule 5 (DESIGN §5): the convention scan. Also the pass that follows the plugin rules, so files
 * no manifest declares are still indexed (standalone). Canonical paths before symlinked aliases,
 * then shallowest first.
 */

import type { Kind } from '../../core/types.js';
import { isDocFile, isScanIgnoredRel } from '../../domain/ignore.js';
import {
  addAgent,
  addCommand,
  addHookFile,
  addInstruction,
  addMcpFile,
  addSkill,
} from '../adders.js';
import { byDepthThenPath } from '../files.js';
import type { ScanContext } from '../scan-context.js';
import { dirDepth, joinRel } from '../util.js';

/** Maximum directory depth of a skill directory found by convention (`a/b/c/d/e/SKILL.md`). */
const SKILL_MAX_DEPTH = 5;
/** Maximum directory depth of other convention-scanned files. */
const OTHER_MAX_DEPTH = 6;

type ConventionKind = Exclude<Kind, 'skill' | 'plugin'>;

interface FileShape {
  base: string;
  lower: string;
  parent?: string;
  grand?: string;
  /** Directory segments. */
  dirs: string[];
}

function shapeOf(rel: string): FileShape {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? '';
  return {
    base,
    lower: base.toLowerCase(),
    parent: segs.length >= 2 ? segs[segs.length - 2] : undefined,
    grand: segs.length >= 3 ? segs[segs.length - 3] : undefined,
    dirs: segs.slice(0, -1),
  };
}

const mdOrToml = (f: FileShape): boolean => f.lower.endsWith('.md') || f.lower.endsWith('.toml');

/** An `agents/` directory at most three levels above the file. */
function inAgentsDir(f: FileShape): boolean {
  const at = f.dirs.lastIndexOf('agents');
  return at !== -1 && at >= f.dirs.length - 3;
}

/** First match wins. */
const CLASSIFIERS: ReadonlyArray<[ConventionKind, (f: FileShape) => boolean]> = [
  ['agent', (f) => f.lower.endsWith('.agent.md')],
  ['instruction', (f) => f.lower.endsWith('.instructions.md')],
  ['command', (f) => f.parent === 'prompts' && f.lower.endsWith('.prompt.md')],
  ['command', (f) => f.parent === 'commands' && mdOrToml(f) && !isDocFile(f.base)],
  ['agent', (f) => inAgentsDir(f) && mdOrToml(f) && !isDocFile(f.base)],
  ['instruction', (f) => f.parent === 'rules' && f.lower.endsWith('.mdc')],
  [
    'instruction',
    (f) => f.parent === 'instructions' && f.lower.endsWith('.md') && !isDocFile(f.base),
  ],
  ['hook', (f) => f.base === 'hooks.json' && (f.parent === 'hooks' || f.grand === 'hooks')],
  ['mcp', (f) => f.base === '.mcp.json' || f.base === 'mcp.json'],
];

function classify(rel: string): ConventionKind | undefined {
  const f = shapeOf(rel);
  if (f.base === 'SKILL.md') return undefined;
  return CLASSIFIERS.find(([, test]) => test(f))?.[0];
}

const ADDERS: Record<ConventionKind, (ctx: ScanContext, rel: string) => Promise<unknown>> = {
  agent: (ctx, rel) => addAgent(ctx, rel, undefined, false),
  command: (ctx, rel) => addCommand(ctx, rel, undefined),
  instruction: (ctx, rel) => addInstruction(ctx, rel, undefined),
  hook: (ctx, rel) => addHookFile(ctx, rel, undefined),
  mcp: (ctx, rel) => addMcpFile(ctx, rel, undefined, false),
};

/** Canonical paths before symlinked aliases, then shallowest first. */
function sortCanonicalFirst(
  ctx: ScanContext,
  items: string[],
  fileOf: (x: string) => string,
): string[] {
  const linked = new Map(items.map((x) => [x, Number(ctx.files.isLinked(fileOf(x)))]));
  return items.sort((a, b) => (linked.get(a) ?? 0) - (linked.get(b) ?? 0) || byDepthThenPath(a, b));
}

async function scanConventionSkills(ctx: ScanContext): Promise<void> {
  const dirs = ctx.files
    .allSkillDirs()
    .filter((d) => dirDepth(`${d}/SKILL.md`) <= SKILL_MAX_DEPTH && !isScanIgnoredRel(d));
  for (const d of sortCanonicalFirst(ctx, dirs, (x) => joinRel(x, 'SKILL.md'))) {
    if (!ctx.registry.isClaimed('skill', d)) await addSkill(ctx, d);
  }
}

async function scanConventionFiles(ctx: ScanContext): Promise<void> {
  const kinds = new Map<string, ConventionKind>();
  for (const f of ctx.files.files) {
    const kind = dirDepth(f) <= OTHER_MAX_DEPTH ? classify(f) : undefined;
    if (kind) kinds.set(f, kind);
  }
  for (const f of sortCanonicalFirst(ctx, [...kinds.keys()], (x) => x)) {
    const kind = kinds.get(f) as ConventionKind;
    if (ctx.registry.isClaimed(kind, f) || ctx.files.insideSkillDir(f) || isScanIgnoredRel(f))
      continue;
    await ADDERS[kind](ctx, f);
  }
}

/** Every skill, then every other convention-shaped file not claimed by an earlier rule. */
export async function scanConvention(ctx: ScanContext): Promise<void> {
  if (ctx.files.isSkillDir('')) {
    // The whole origin is one skill; everything else is part of it.
    await addSkill(ctx, '');
    return;
  }
  await scanConventionSkills(ctx);
  await scanConventionFiles(ctx);
}
