import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import {
  KINDS,
  type Kind,
  type LockEntry,
  type Lockfile,
  type Manifest as ManifestData,
  type PalmContext,
  type Scope,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import { Lock, type RemovalPlan } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin, removeEmptyParents } from '../lib/fs.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';

export type { RemovalPlan } from '../domain/lock.js';

/** @deprecated prefer `ScopePaths.abs`. */
export function absScopeFile(root: string, file: string): string {
  return isAbsolute(file) ? file : join(root, file);
}

/** The directory `depth` levels below `base` on the way to `file`, or undefined outside `base`. */
function levelBelow(base: string, file: string, depth: number): string | undefined {
  if (!isWithin(file, base)) return undefined;
  return join(base, ...relative(base, file).split(sep).slice(0, depth));
}

/**
 * Remove the now-empty directories above `file`, never touching the harness container dirs:
 * pruning stops two levels below the scope root (`.claude/skills`) and one level below palm's
 * home (`~/.palm/hooks`), whichever lets more go.
 */
async function pruneEmptyDirs(paths: ScopePaths, file: string): Promise<void> {
  const stops = [levelBelow(paths.root, file, 2), levelBelow(paths.palmHome, file, 1)];
  const stop = stops
    .filter((d): d is string => d !== undefined)
    .sort((a, b) => a.length - b.length)[0];
  if (stop) await removeEmptyParents(file, stop);
}

/**
 * Containers palm itself creates and may remove once empty: the shared `.agents/skills`
 * (and `.agents`), and the project `.palm/hooks` (and `.palm`) / global `<palmHome>/hooks`.
 * Harness config dirs (`.claude`, `.codex`, `.cursor`, `.github`, `.vscode`) are never removed.
 * Each is `{ dir, top }`: `dir` and its parents up to and including `top`.
 */
function palmContainers(paths: ScopePaths): Array<{ dir: string; top: string }> {
  const agents = join(paths.root, '.agents');
  const hooksTop = paths.scope === 'project' ? paths.palmDir : paths.hooksDir;
  return [
    { dir: join(agents, 'skills'), top: agents },
    { dir: paths.hooksDir, top: hooksTop },
  ];
}

async function pruneContainers(paths: ScopePaths, touched: string[]): Promise<void> {
  for (const { dir, top } of palmContainers(paths)) {
    // removeEmptyParents starts at the parent of its first argument, i.e. at `dir`.
    if (touched.some((f) => isWithin(f, top)))
      await removeEmptyParents(join(dir, '_'), dirname(top));
  }
}

/**
 * Absolute paths that must survive removal: shared merge targets and files owned by entries
 * that stay. `leaving` holds lock ids (`lockId`).
 * @deprecated prefer `Lock.protectedFiles`.
 */
export function protectedFiles(root: string, lock: Lockfile, leaving: Set<string>): Set<string> {
  const gone = lock.entries.filter((e) => leaving.has(lockId(e)));
  return Lock.from(lock).protectedFiles({ abs: (f) => absScopeFile(root, f) }, gone);
}

/** Deletes one file or directory palm owns, then the empty directories above it. */
async function removeOwned(paths: ScopePaths, abs: string, warnings: string[]): Promise<void> {
  if (existsSync(abs)) {
    try {
      await rm(abs, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`could not remove ${abs}: ${messageOf(e)}`);
      return;
    }
  }
  await pruneEmptyDirs(paths, abs);
}

/** Removes the entry's files that stay inside the scope and are not protected; returns them all. */
async function removeFiles(
  paths: ScopePaths,
  files: string[],
  protect: Set<string>,
  warnings: string[],
): Promise<string[]> {
  const touched: string[] = [];
  for (const f of files) {
    const abs = paths.safeAbs(f);
    if (!abs) continue; // never delete outside the scope, whatever the lockfile says
    touched.push(abs);
    if (!protect.has(abs)) await removeOwned(paths, abs, warnings);
  }
  return touched;
}

/**
 * Undeploy lock entries from every target they were installed to, then remove
 * any listed file a target left behind (palm owns everything in `files`).
 */
export async function undeployEntries(
  ctx: PalmContext,
  deps: EngineDeps,
  scope: Scope,
  entries: LockEntry[],
  protect: Set<string>,
  warnings: string[],
): Promise<void> {
  const paths = ScopePaths.of(ctx, scope);
  const touched: string[] = [];
  for (const entry of entries) {
    const outside = entry.files.filter((f) => !paths.safeAbs(f));
    if (outside.length)
      warnings.push(
        `${entry.kind} ${entry.name}: ignored lock paths outside the ${scope} scope: ${outside.join(', ')}`,
      );
    for (const id of entry.targets) {
      try {
        await deps.getTarget(id).undeploy(entry, scope, paths.root, ctx.flags.dryRun, ctx.env);
      } catch (e) {
        warnings.push(`${entry.kind} ${entry.name} → ${id}: ${messageOf(e)}`);
      }
    }
    if (!ctx.flags.dryRun)
      touched.push(...(await removeFiles(paths, entry.files, protect, warnings)));
  }
  if (!ctx.flags.dryRun) await pruneContainers(paths, touched);
}

/**
 * Entries installed as dependencies of `parents` (transitively), without descending into
 * `kept` (lock ids, see `LockKey.id`). See `Lock.dependentsOf`.
 */
export function collectDependents(
  lock: Lockfile,
  parents: LockEntry[],
  kept: Set<string> = new Set(),
): LockEntry[] {
  return Lock.from(lock).dependentsOf(parents, kept);
}

/**
 * True when the manifest lists `e` directly (registry MCP servers also match by registry name).
 * @deprecated prefer `Manifest.lists`.
 */
export function manifestLists(
  manifest: ManifestData | undefined,
  e: Pick<LockEntry, 'kind' | 'name' | 'origin' | 'path'>,
): boolean {
  return !!manifest && Manifest.of(manifest).lists(e);
}

/** Reference-counted removal over plain lock data. See `Lock.planRemoval`. */
export function planRemoval(
  lock: Lockfile,
  roots: LockEntry[],
  opts: { manifest?: ManifestData; checkRoots?: boolean } = {},
): RemovalPlan {
  const manifest = opts.manifest ? Manifest.of(opts.manifest) : undefined;
  return Lock.from(lock).planRemoval(roots, {
    listed: (e) => !!manifest?.lists(e),
    checkRoots: !!opts.checkRoots,
  });
}

/** Apply the `via` changes of a removal plan to the lock. */
export function reparent(lock: Lockfile, kept: RemovalPlan['kept']): Lockfile {
  return Lock.from(lock).reparent(kept).toJSON();
}

type RemovalRef = { kind?: Kind; name: string; origin?: string };

function notInstalled(ref: RemovalRef, scope: Scope): PalmError {
  return new PalmError(
    'E_NOT_FOUND',
    `${ref.kind ?? 'Nothing'} named "${ref.name}"${ref.origin ? ` from ${ref.origin}` : ''} is ${ref.kind ? 'not ' : ''}installed${scope === 'global' ? ' globally' : ' in this project'}`,
    scope === 'global' ? 'See `palm list -g`.' : 'See `palm list` (add -g for global installs).',
  );
}

/**
 * The lock entries the refs name; a ref that names nothing installed but a manifest entry
 * goes to `manifestOnly` (one item per kind, one warning per ref). Throws E_NOT_FOUND, or
 * E_AMBIGUOUS when a name spans kinds.
 */
function selectForRemoval(
  lock: Lock,
  manifest: Manifest,
  refs: RemovalRef[],
  scope: Scope,
): {
  selected: LockEntry[];
  manifestOnly: Array<{ kind: Kind; name: string }>;
  warnings: string[];
} {
  const selected: LockEntry[] = [];
  const manifestOnly: Array<{ kind: Kind; name: string }> = [];
  const warnings: string[] = [];
  for (const ref of refs) {
    const matches = lock.select(ref);
    if (matches.length === 0) {
      const kinds = (ref.kind ? [ref.kind] : KINDS).filter((k) => manifest.hasDep(k, ref.name));
      if (!kinds.length) throw notInstalled(ref, scope);
      for (const k of kinds) manifestOnly.push({ kind: k, name: ref.name });
      warnings.push(`${ref.name} was not installed; removed it from the manifest`);
      continue;
    }
    const kinds = [...new Set(matches.map((m) => m.kind))];
    if (kinds.length > 1) {
      throw new PalmError(
        'E_AMBIGUOUS',
        `"${ref.name}" is installed as ${kinds.join(' and ')}`,
        `Name the kind: ${kinds.map((k) => `palm uninstall ${k} ${ref.name}`).join(' | ')}`,
      );
    }
    selected.push(...matches);
  }
  return { selected, manifestOnly, warnings };
}

/** Warnings for selected entries that entries which stay still list in `deps`. */
function stillUsedWarnings(lock: Lock, selected: LockEntry[], removed: LockEntry[]): string[] {
  const leaving = new Set(removed.map(lockId));
  return selected.flatMap((s) => {
    const users = lock.usersOf(s, leaving);
    if (!users.length) return [];
    const who = users.map((u) => `${u.kind} ${u.name}`).join(', ');
    return [`${who} still reference${users.length === 1 ? 's' : ''} ${s.kind} ${s.name}`];
  });
}

function keptWarning(k: RemovalPlan['kept'][number]): string {
  const via = k.via ? Via.parse(k.via) : undefined;
  const why = via ? `still needed by ${via.kind} ${via.name}` : 'listed in the manifest';
  return `kept ${k.entry.kind} ${k.entry.name}: ${why}`;
}

/** Drops removed direct installs (registry MCP servers also by registry name) from the manifest. */
function forgetRemoved(manifest: Manifest, removed: LockEntry[]): void {
  for (const e of removed) {
    if (e.via) continue;
    manifest.removeDep(e.kind, e.name);
    if (e.kind === 'mcp' && e.origin === 'registry') manifest.removeDep(e.kind, e.path);
  }
}

export async function uninstallEntities(
  ctx: PalmContext,
  refs: RemovalRef[],
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<{ removed: LockEntry[]; warnings: string[] }> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const manifest = await Manifest.load(paths.manifestFile);
  const manifestBefore = JSON.stringify(manifest);

  const { selected, manifestOnly, warnings } = selectForRemoval(lock, manifest, refs, opts.scope);
  const { removed, kept } = lock.planRemoval(selected, { listed: (e) => manifest.lists(e) });
  warnings.push(...stillUsedWarnings(lock, selected, removed));
  const protect = lock.protectedFiles(paths, removed);
  await undeployEntries(ctx, deps, opts.scope, removed, protect, warnings);
  warnings.push(...kept.map(keptWarning));

  lock.reparent(kept);
  for (const e of removed) lock.remove(e);
  forgetRemoved(manifest, removed);
  for (const m of manifestOnly) manifest.removeDep(m.kind, m.name);

  if (!ctx.flags.dryRun) {
    if (removed.length || kept.length) await lock.save(paths.lockFile);
    if (JSON.stringify(manifest) !== manifestBefore) await manifest.save(paths.manifestFile);
  }
  return { removed, warnings };
}
