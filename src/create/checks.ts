/**
 * What `palm create` checks before it writes a byte (rulings K13, B6, J6, C27), the same for a
 * dry run and a real run: a name that is one path segment, a source directory the scope may use
 * (inside the project or its git worktree; under `-g`, inside the home directory) and that is no
 * harness output, a target to install for, and a name the source does not index yet.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { LayoutDescriptor, PalmContext, Scope } from '../core/types.js';
import { isWithin } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';
import type { CliDeps, ScopeState } from './engine.js';
import { engineOf, targetOf } from './engine.js';
import { layoutGlobs } from './place.js';

/** The command line that retries `create` with another `--in`. */
function createLine(kind: string, name: string, scope: Scope, dir: string): string {
  return `palm create ${kind} ${name} --in ${dir}${scope === 'global' ? ' -g' : ''}`;
}

export function assertName(kind: string, name: string): void {
  if (!isSafeName(name))
    throw new PalmError(
      'E_USAGE',
      `"${name}" is not a name: use letters, digits, ".", "_" or "-"`,
      `palm create ${kind} release-notes`,
    );
}

/** The git worktree around `root` (the nearest ancestor holding `.git`), else `root`. */
function worktreeOf(root: string): string {
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(root);
    dir = up;
  }
}

/**
 * `--in` must lie where the scope may declare a source (J6, B9): inside the project or its git
 * worktree, or under `-g` inside the home directory or palm's home.
 */
export function assertDirAllowed(
  ctx: PalmContext,
  dir: string,
  at: { kind: string; name: string; scope: Scope },
): void {
  const { paths } = ctx;
  if (at.scope === 'global') {
    if (isWithin(dir, paths.home) || isWithin(dir, paths.palmHome)) return;
    throw new PalmError(
      'E_SOURCE',
      `${dir} is outside your home directory; a global source lives under it`,
      createLine(at.kind, at.name, 'global', '~/.palm/kit'),
    );
  }
  if (isWithin(dir, paths.projectRoot) || isWithin(dir, worktreeOf(paths.projectRoot))) return;
  throw new PalmError(
    'E_SOURCE',
    `${dir} is outside the project ${paths.projectRoot}; palm create writes into a directory of the project`,
    createLine(at.kind, at.name, 'project', './agent-kit'),
  );
}

/** No target to install for: the engine's refusal, before the template is written (K13). */
export function assertTargets(state: ScopeState): void {
  if (state.targets.length > 0) return;
  const g = state.paths.scope === 'global' ? ' -g' : '';
  throw new PalmError(
    'E_USAGE',
    'no target: palm.yaml names none and no harness directory was found',
    `palm init${g} --target claude`,
  );
}

/** Harness roots a layout glob must stay clear of (N8), whichever targets are active. */
const HARNESS_ROOTS = [
  '.claude',
  '.agents',
  '.cursor',
  '.github',
  '.codex',
  '.gemini',
  '.opencode',
];

interface Output {
  id: string;
  /** As the target names it (project-relative), for messages. */
  dir: string;
  abs: string;
}

/** The output directories of the active targets, and `.palm`. */
async function outputsOf(ctx: PalmContext, deps: CliDeps, state: ScopeState): Promise<Output[]> {
  const root = state.paths.root;
  const outputs = [{ id: 'palm', dir: '.palm' }];
  for (const id of state.targets)
    for (const out of (await targetOf(deps, id)).outputDirs('project', root, ctx.env))
      outputs.push({ id, dir: out });
  return outputs.map((o) => ({ ...o, abs: resolve(root, o.dir) }));
}

/** The part of a glob before its first wildcard segment (`packages/*` → `packages`). */
function staticBase(glob: string): string {
  const segs = glob.replace(/^\.\//, '').split('/');
  const at = segs.findIndex((s) => /[*?[\]{}!]/.test(s));
  return (at < 0 ? segs : segs.slice(0, at)).join('/');
}

const overlaps = (a: string, b: string): boolean => isWithin(a, b) || isWithin(b, a);

/**
 * N8: the first glob of the source's layout that reaches an output directory, a harness root or
 * `.palm` (its fixed part holds one or lies in one); undefined when every glob stays clear.
 */
function globReachingOutput(
  dir: string,
  globs: readonly string[],
  outputs: readonly Output[],
): { glob: string; out: string } | undefined {
  const roots = [...HARNESS_ROOTS, '.palm'].map((d) => resolve(dir, d));
  const all = [...outputs.map((o) => o.abs), ...roots];
  for (const glob of globs) {
    const base = resolve(dir, staticBase(glob));
    const hit = all.find((o) => overlaps(base, o));
    if (hit) return { glob, out: relative(dir, hit) || '.' };
  }
  return undefined;
}

/** How a directory holding an output directory becomes usable; nothing for a harness folder. */
function declareAdvice(root: string, dir: string): string {
  if (HARNESS_ROOTS.some((r) => isWithin(dir, resolve(root, r)))) return '';
  return `; declare ${relative(root, dir) || '.'} with a layout that keeps clear of it`;
}

function overlapError(root: string, dir: string, o: Output, why: string): PalmError {
  return new PalmError(
    'E_SOURCE',
    `${relative(root, dir) || '.'} overlaps the ${o.id} output directory ${o.dir}/${why}`,
    'palm create writes into a source of its own, for example --in ./agent-kit',
  );
}

/**
 * A source directory that is or lies in an output directory of an active target, or in `.palm`,
 * is refused (project scope; the engine checks every scope again at install). One that holds
 * such a directory (the repository root `.`) is allowed when its declared `layout` indexes only
 * places clear of every output directory and harness root (ruling N8).
 */
export async function assertNoOverlap(
  ctx: PalmContext,
  deps: CliDeps,
  state: ScopeState,
  at: { dir: string; layout?: LayoutDescriptor },
): Promise<void> {
  if (state.paths.scope !== 'project') return;
  const outputs = await outputsOf(ctx, deps, state);
  const root = state.paths.root;
  const inside = outputs.find((o) => isWithin(at.dir, o.abs));
  if (inside) throw overlapError(root, at.dir, inside, '');
  const held = outputs.find((o) => isWithin(o.abs, at.dir));
  if (!held) return;
  const globs = layoutGlobs(at.layout);
  if (globs.length === 0) throw overlapError(root, at.dir, held, declareAdvice(root, at.dir));
  const reach = globReachingOutput(at.dir, globs, outputs);
  if (reach)
    throw overlapError(root, at.dir, held, `; its layout glob ${reach.glob} reaches ${reach.out}/`);
}

/**
 * C27: the source already indexes an entity of this kind and name somewhere else (the template
 * would shadow it or be shadowed). The template's own path is a rerun, not a clash.
 */
export async function assertNotIndexed(
  ctx: PalmContext,
  deps: CliDeps,
  at: { input: string; dir: string; kind: string; name: string; path: string; scope: Scope },
): Promise<void> {
  if (!existsSync(at.dir)) return;
  const listing = await engineOf(deps).listSource(ctx, at.input, { scope: at.scope });
  const found = listing.index.entities.find((e) => e.kind === at.kind && e.name === at.name);
  if (!found || found.path === at.path) return;
  const g = at.scope === 'global' ? ' -g' : '';
  throw new PalmError(
    'E_CONFLICT',
    `${at.kind} ${at.name} already exists in ${at.input} (${found.path})`,
    `install the one that is there: palm install ${at.input} ${at.kind}:${at.name}${g}`,
  );
}
