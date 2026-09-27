import { existsSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PalmError } from '../core/errors.js';
import { loadLock, removeEntry, saveLock } from '../core/lockfile.js';
import { listDeps, loadManifest, removeDep, saveManifest } from '../core/manifest.js';
import { lockPath, manifestPath, scopeRoot } from '../core/paths.js';
import { KINDS, type Kind, type LockEntry, type Lockfile, type PalmContext, type Scope } from '../core/types.js';
import { resolveEngineDeps, undeployWithEnv, type EngineDeps } from './deps.js';
import { nameMatchesEntry } from './query.js';

function entryKey(e: { kind: Kind; name: string; origin: string }): string {
  return `${e.kind}\0${e.name.toLowerCase()}\0${e.origin}`;
}

export function absScopeFile(root: string, file: string): string {
  return isAbsolute(file) ? file : join(root, file);
}

/** Remove now-empty directories upward, never touching the harness container dirs (`.claude/skills`, `~/.palm/hooks`, …). */
async function pruneEmptyDirs(ctx: PalmContext, root: string, start: string): Promise<void> {
  const stops: Array<{ base: string; min: number }> = [
    { base: root, min: 3 },
    { base: ctx.paths.palmHome, min: 2 },
  ];
  let dir = start;
  for (;;) {
    const removable = stops.some(({ base, min }) => {
      const rel = relative(base, dir);
      return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep).length >= min;
    });
    if (!removable) return;
    try {
      await rmdir(dir);
    } catch {
      return; // not empty or already gone
    }
    dir = dirname(dir);
  }
}

/** Absolute paths that must survive removal: shared merge targets and files owned by entries that stay. */
export function protectedFiles(root: string, lock: Lockfile, leaving: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const e of lock.entries) {
    for (const m of e.merged ?? []) out.add(absScopeFile(root, m.file));
    if (!leaving.has(entryKey(e))) for (const f of e.files) out.add(absScopeFile(root, f));
  }
  return out;
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
  const root = scopeRoot(ctx.paths, scope);
  for (const entry of entries) {
    for (const id of entry.targets) {
      try {
        await undeployWithEnv(deps.getTarget(id), entry, scope, root, ctx.flags.dryRun, ctx.env);
      } catch (e) {
        warnings.push(`${entry.kind} ${entry.name} → ${id}: ${(e as Error).message}`);
      }
    }
    if (ctx.flags.dryRun) continue;
    for (const f of entry.files) {
      const abs = absScopeFile(root, f);
      if (protect.has(abs)) continue;
      if (existsSync(abs)) {
        try {
          await rm(abs, { recursive: true, force: true });
        } catch (e) {
          warnings.push(`could not remove ${abs}: ${(e as Error).message}`);
          continue;
        }
      }
      await pruneEmptyDirs(ctx, root, dirname(abs));
    }
  }
}

/** Entries installed as dependencies of `parents` (transitively). */
export function collectDependents(lock: Lockfile, parents: LockEntry[]): LockEntry[] {
  const seen = new Map<string, LockEntry>();
  const queue = [...parents];
  while (queue.length) {
    const e = queue.shift()!;
    const key = entryKey(e);
    if (seen.has(key)) continue;
    seen.set(key, e);
    if (e.kind === 'plugin' || e.kind === 'agent') {
      const via = `${e.kind}:${e.name}`;
      for (const d of lock.entries) if (d.via === via) queue.push(d);
    }
  }
  return [...seen.values()];
}

export async function uninstallEntities(
  ctx: PalmContext,
  refs: Array<{ kind?: Kind; name: string; origin?: string }>,
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<{ removed: LockEntry[]; warnings: string[] }> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const lockFile = lockPath(ctx.paths, opts.scope);
  const manFile = manifestPath(ctx.paths, opts.scope);
  let lock = await loadLock(lockFile);
  let manifest = await loadManifest(manFile);
  const manifestBefore = JSON.stringify(manifest);
  const warnings: string[] = [];

  const selected: LockEntry[] = [];
  const manifestOnly: Array<{ kind: Kind; name: string }> = [];
  for (const ref of refs) {
    const matches = lock.entries.filter(
      (e) => (!ref.kind || e.kind === ref.kind) && nameMatchesEntry(e, ref.name) && (!ref.origin || e.origin === ref.origin),
    );
    if (matches.length === 0) {
      const lower = ref.name.toLowerCase();
      const kinds = (ref.kind ? [ref.kind] : KINDS).filter((k) =>
        listDeps(manifest, k).some((d) => d.name.toLowerCase() === lower || ('registry' in d && d.registry?.toLowerCase() === lower)),
      );
      if (kinds.length) {
        for (const k of kinds) manifestOnly.push({ kind: k, name: ref.name });
        warnings.push(`${ref.name} was not installed; removed it from the manifest`);
        continue;
      }
      throw new PalmError(
        'E_NOT_FOUND',
        `${ref.kind ?? 'Nothing'} named "${ref.name}"${ref.origin ? ` from ${ref.origin}` : ''} is ${ref.kind ? 'not ' : ''}installed${opts.scope === 'global' ? ' globally' : ' in this project'}`,
        opts.scope === 'global' ? 'See `palm list -g`.' : 'See `palm list` (add -g for global installs).',
      );
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

  const removed = collectDependents(lock, selected);
  const leaving = new Set(removed.map(entryKey));
  const root = scopeRoot(ctx.paths, opts.scope);
  await undeployEntries(ctx, deps, opts.scope, removed, protectedFiles(root, lock, leaving), warnings);

  for (const e of removed) {
    lock = removeEntry(lock, e.kind, e.name, e.origin);
    if (!e.via) {
      manifest = removeDep(manifest, e.kind, e.name);
      if (e.kind === 'mcp' && e.origin === 'registry') manifest = removeDep(manifest, e.kind, e.path);
    }
  }
  for (const m of manifestOnly) manifest = removeDep(manifest, m.kind, m.name);

  if (!ctx.flags.dryRun) {
    if (removed.length) await saveLock(lockFile, lock);
    if (JSON.stringify(manifest) !== manifestBefore) await saveManifest(manFile, manifest);
  }
  return { removed, warnings };
}
