/**
 * Stray files in folders palm owns whole (C13): a skill's folder per harness and a closure copy
 * under `.palm/assets`. `check` fails on a file there that no lock entry lists; `install --force`
 * of the entry deletes them. Nothing inside a declared source, and nothing reached through a
 * symbolic link (T1), is ever listed or deleted.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { LockEntry } from '../core/types.js';
import { isWithin, removeEmptyParents, walkFiles } from '../lib/fs.js';
import { isLinked } from './delete-guard.js';
import type { ScopeState } from './scope.js';

/** The folders palm owns whole for an entry: a skill's folder per harness, a closure copy. */
function ownedDirs(state: ScopeState, e: LockEntry): string[] {
  const dirs = new Set<string>();
  const segment = `/${e.name}/`;
  if (e.kind === 'skill')
    for (const file of e.files) {
      const at = file.indexOf(segment);
      if (at >= 0) dirs.add(file.slice(0, at + segment.length - 1));
    }
  const closure = e.exec?.closure?.root;
  if (closure?.startsWith(state.paths.lockForm(state.paths.assetsDir))) dirs.add(closure);
  return [...dirs];
}

/** Absolute paths of the declared in-repo sources. */
export function localSourceDirs(state: ScopeState): string[] {
  return state.sources.all().flatMap((s) => (s.isLocal && s.source.path ? [s.source.path] : []));
}

/**
 * Files below `dir` (lock form) that no lock entry lists. A folder reached through a symbolic
 * link (`.claude/skills/fmt -> ../../.agents/skills/fmt`) is never a candidate (T1): what it
 * holds belongs to wherever the link points, and palm deletes nothing through it. Nor is one
 * whose real path lies in a declared source.
 */
async function unlisted(state: ScopeState, dir: string, listed: Set<string>): Promise<string[]> {
  const abs = state.paths.abs(dir);
  if (!existsSync(abs) || localSourceDirs(state).some((s) => isWithin(abs, s))) return [];
  const { real, inside } = await state.paths.realInside(abs);
  if (!inside || (await isLinked(state.paths, abs, real))) return [];
  if (localSourceDirs(state).some((s) => isWithin(real, s))) return [];
  return (await walkFiles(abs)).files.map((f) => `${dir}/${f.rel}`).filter((r) => !listed.has(r));
}

/** The entry's stray files, by owned folder (lock form). */
export async function orphansOf(
  state: ScopeState,
  e: LockEntry,
): Promise<Array<{ dir: string; file: string }>> {
  const listed = new Set(state.lock.entries.flatMap((x) => x.files));
  const out: Array<{ dir: string; file: string }> = [];
  for (const dir of ownedDirs(state, e))
    for (const file of await unlisted(state, dir, listed)) out.push({ dir, file });
  return out;
}

/**
 * `install --force` (C13): deletes the entry's stray files and returns the note for its row
 * (`removed 2 stray files`, or `would remove …` in a dry run); undefined when there were none.
 */
export async function removeOrphans(
  state: ScopeState,
  e: LockEntry,
  dryRun: boolean,
): Promise<string | undefined> {
  const stray = await orphansOf(state, e);
  if (!stray.length) return undefined;
  if (!dryRun)
    for (const { dir, file } of stray) {
      const abs = state.paths.abs(file);
      await rm(abs, { force: true });
      await removeEmptyParents(abs, state.paths.abs(dir));
    }
  const n = stray.length === 1 ? '1 file' : `${stray.length} files`;
  const shown = `${stray[0]?.file}${stray.length > 1 ? ', …' : ''}`;
  return `${dryRun ? 'would remove' : 'removed'} ${n} palm.lock.yaml does not list: ${shown}`;
}
