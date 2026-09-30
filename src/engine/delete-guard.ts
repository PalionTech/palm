/**
 * What palm may delete (DESIGN §2 rule 4, extended by T1): every delete resolves the real path
 * first. A file is kept when its real path lies inside a declared source, when it is the real
 * path of a file that stays (another entry's, or this entry's new render), or when it is
 * reached through a symbolic link into another target's output directory
 * (`.claude/skills/fmt -> ../../.agents/skills/fmt` must never cost Codex its files). A path
 * whose real path leaves the scope is refused.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { type EngineDeps, type PalmContext, TARGET_IDS, type TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';

interface OutputDir {
  target: TargetId;
  /** Lock form. */
  lock: string;
  /** Absolute, as written. */
  dir: string;
  /** Absolute, symlinks resolved. */
  real: string;
}

/** What a delete must leave alone, resolved once per run. */
export interface DeleteGuard {
  paths: ScopePaths;
  /** Real paths of the files that stay, with their owner (`skill x from kit`). */
  staying: ReadonlyMap<string, string>;
  /** Real paths of the declared in-repo sources. */
  sources: readonly string[];
  outputs: readonly OutputDir[];
}

/** Why a file stays (`kept`), or that it lies outside the scope, or that it may go. */
export type DeleteVerdict =
  | { action: 'delete'; real: string }
  | { action: 'keep'; reason: 'owned' | 'source'; owner?: string; real: string }
  | { action: 'outside'; real: string };

async function realOf(abs: string): Promise<string> {
  return realpath(abs).catch(() => path.resolve(abs));
}

/** The output directories of every target at this scope (shared ones once per target). */
async function outputDirs(ctx: PalmContext, deps: EngineDeps, paths: ScopePaths) {
  const out: OutputDir[] = [];
  for (const target of TARGET_IDS)
    for (const lock of deps.getTarget(target).outputDirs(paths.scope, paths.root, ctx.env)) {
      const dir = paths.abs(lock);
      out.push({ target, lock, dir, real: await realOf(dir) });
    }
  return out;
}

/**
 * The guard for one run: `staying` lists the lock paths that stay (`file#at#key` fragment keys
 * are ignored) with their owner; `sources` are the real paths of the in-repo sources.
 */
export async function deleteGuard(
  ctx: PalmContext,
  deps: EngineDeps,
  paths: ScopePaths,
  opts: { staying: ReadonlyMap<string, string>; sources: readonly string[] },
): Promise<DeleteGuard> {
  const staying = new Map<string, string>();
  for (const [file, owner] of opts.staying) {
    if (file.includes('#')) continue;
    const { real } = await paths.realInside(paths.abs(file));
    if (!staying.has(real)) staying.set(real, owner);
  }
  return { paths, staying, sources: opts.sources, outputs: await outputDirs(ctx, deps, paths) };
}

/** The deepest scope boundary holding `abs` (lexically). */
function boundaryOf(paths: ScopePaths, abs: string): string | undefined {
  let best: string | undefined;
  for (const b of paths.boundaries())
    if (isWithin(abs, b) && (!best || b.length > best.length)) best = b;
  return best;
}

/**
 * True when `abs` reaches `real` through a symbolic link below its scope boundary
 * (`.claude/skills/x -> ../../.agents/skills/x`); a linked boundary itself (`~/.claude` kept in
 * a dotfiles repository) does not count.
 */
export async function isLinked(paths: ScopePaths, abs: string, real: string): Promise<boolean> {
  const b = boundaryOf(paths, abs);
  if (!b) return true;
  return path.resolve(await realOf(b), path.relative(b, abs)) !== real;
}

/** The other target's output directory a linked path lands in, if any. */
function foreignOutput(g: DeleteGuard, abs: string, real: string): OutputDir | undefined {
  return g.outputs.find((o) => isWithin(real, o.real) && !isWithin(abs, o.dir));
}

/** The verdict for one lock path (T1). */
export async function judgeDelete(g: DeleteGuard, lockPath: string): Promise<DeleteVerdict> {
  const abs = g.paths.abs(lockPath);
  const { real, inside } = await g.paths.realInside(abs);
  if (!inside) return { action: 'outside', real };
  if (g.sources.some((s) => isWithin(real, s))) return { action: 'keep', reason: 'source', real };
  const owner = g.staying.get(real);
  if (owner !== undefined) return { action: 'keep', reason: 'owned', owner, real };
  const other = (await isLinked(g.paths, abs, real)) ? foreignOutput(g, abs, real) : undefined;
  if (other)
    return { action: 'keep', reason: 'owned', owner: `${other.target} (${other.lock})`, real };
  return { action: 'delete', real };
}
