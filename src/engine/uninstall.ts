import { existsSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PalmError } from '../core/errors.js';
import { loadLock, removeEntry, saveLock, upsertEntry } from '../core/lockfile.js';
import { isMcpManifestEntry, listDeps, loadManifest, removeDep, saveManifest } from '../core/manifest.js';
import { lockPath, manifestPath, safeScopePath, scopeRoot } from '../core/paths.js';
import { KINDS, type Kind, type LockEntry, type Lockfile, type Manifest, type PalmContext, type Scope } from '../core/types.js';
import { resolveEngineDeps, type EngineDeps } from './deps.js';
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

/**
 * Containers palm itself creates and may remove once empty: the shared `.agents/skills`
 * (and `.agents`), and the project `.palm/hooks` (and `.palm`) / global `<palmHome>/hooks`.
 * Harness config dirs (`.claude`, `.codex`, `.cursor`, `.github`, `.vscode`) are never removed.
 */
function palmContainers(ctx: PalmContext, scope: Scope, root: string): string[][] {
  const chains = [[join(root, '.agents', 'skills'), join(root, '.agents')]];
  if (scope === 'project') chains.push([join(root, '.palm', 'hooks'), join(root, '.palm')]);
  else chains.push([join(ctx.paths.palmHome, 'hooks')]);
  return chains;
}

async function pruneContainers(ctx: PalmContext, scope: Scope, root: string, touched: string[]): Promise<void> {
  for (const chain of palmContainers(ctx, scope, root)) {
    const top = chain[chain.length - 1]!;
    if (!touched.some((f) => f === top || f.startsWith(top + sep))) continue;
    for (const dir of chain) {
      try {
        await rmdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') break; // not empty: keep the parent too
      }
    }
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
  const touched: string[] = [];
  for (const entry of entries) {
    const outside = entry.files.filter((f) => !safeScopePath(ctx.paths, scope, f, ctx.env));
    if (outside.length) warnings.push(`${entry.kind} ${entry.name}: ignored lock paths outside the ${scope} scope: ${outside.join(', ')}`);
    for (const id of entry.targets) {
      try {
        await deps.getTarget(id).undeploy(entry, scope, root, ctx.flags.dryRun, ctx.env);
      } catch (e) {
        warnings.push(`${entry.kind} ${entry.name} → ${id}: ${(e as Error).message}`);
      }
    }
    if (ctx.flags.dryRun) continue;
    for (const f of entry.files) {
      const abs = safeScopePath(ctx.paths, scope, f, ctx.env);
      if (!abs) continue; // never delete outside the scope, whatever the lockfile says
      touched.push(abs);
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
  if (!ctx.flags.dryRun) await pruneContainers(ctx, scope, root, touched);
}

/** Entries installed as dependencies of `parents` (transitively), without descending into `kept`. */
export function collectDependents(lock: Lockfile, parents: LockEntry[], kept: Set<string> = new Set()): LockEntry[] {
  const seen = new Map<string, LockEntry>();
  const queue = [...parents];
  while (queue.length) {
    const e = queue.shift()!;
    const key = entryKey(e);
    if (seen.has(key) || kept.has(key)) continue;
    seen.set(key, e);
    if (e.kind === 'plugin' || e.kind === 'agent') {
      const via = `${e.kind}:${e.name}`;
      for (const d of lock.entries) if (d.via === via) queue.push(d);
    }
  }
  return [...seen.values()];
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True when the manifest lists `e` directly (registry MCP servers also match by registry name). */
export function manifestLists(manifest: Manifest | undefined, e: Pick<LockEntry, 'kind' | 'name' | 'origin' | 'path'>): boolean {
  if (!manifest) return false;
  return listDeps(manifest, e.kind).some(
    (d) =>
      sameName(d.name, e.name) ||
      (e.kind === 'mcp' && e.origin === 'registry' && ((isMcpManifestEntry(d) && !!d.registry && sameName(d.registry, e.path)) || sameName(d.name, e.path))),
  );
}

export interface RemovalPlan {
  /** Entries to undeploy and drop from the lock. */
  removed: LockEntry[];
  /** `via` dependencies that stay because another entry still needs them, with their new `via` (undefined = now direct). */
  kept: Array<{ entry: LockEntry; via?: string }>;
}

/**
 * Reference-counted removal (DESIGN §6 "drop `via` deps that no other entry needs").
 * Starting from `roots`, follow `via` links; a dependency stays when the manifest lists it
 * directly or when an entry that is not being removed lists it in `deps`. With
 * `checkRoots` the roots themselves are subject to the same check (orphaned dependencies).
 */
export function planRemoval(lock: Lockfile, roots: LockEntry[], opts: { manifest?: Manifest; checkRoots?: boolean } = {}): RemovalPlan {
  const rootKeys = new Set(roots.map(entryKey));
  const keptKeys = new Set<string>();
  const newVia = new Map<string, string | undefined>();
  let removed: LockEntry[] = [];
  for (;;) {
    removed = collectDependents(lock, roots, keptKeys);
    const removing = new Set(removed.map(entryKey));
    let changed = false;
    for (const c of removed) {
      const key = entryKey(c);
      if (rootKeys.has(key) && !opts.checkRoots) continue;
      if (!c.via && !rootKeys.has(key)) continue;
      if (manifestLists(opts.manifest, c)) {
        keptKeys.add(key);
        newVia.set(key, undefined);
        changed = true;
        continue;
      }
      const parent = lock.entries.find(
        (p) => !removing.has(entryKey(p)) && (p.deps ?? []).some((d) => d.kind === c.kind && sameName(d.name, c.name)),
      );
      if (parent) {
        keptKeys.add(key);
        newVia.set(key, `${parent.kind}:${parent.name}`);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const kept = lock.entries
    .filter((e) => keptKeys.has(entryKey(e)))
    .map((entry) => {
      const via = newVia.get(entryKey(entry));
      return via ? { entry, via } : { entry };
    });
  return { removed, kept };
}

/** Apply the `via` changes of a removal plan to the lock. */
export function reparent(lock: Lockfile, kept: RemovalPlan['kept']): Lockfile {
  let out = lock;
  for (const k of kept) {
    const next: LockEntry = { ...k.entry };
    if (k.via) next.via = k.via;
    else delete next.via;
    out = upsertEntry(out, next);
  }
  return out;
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

  const plan = planRemoval(lock, selected, { manifest });
  const removed = plan.removed;
  const leaving = new Set(removed.map(entryKey));
  for (const s of selected) {
    const users = lock.entries.filter(
      (p) => !leaving.has(entryKey(p)) && (p.deps ?? []).some((d) => d.kind === s.kind && sameName(d.name, s.name)),
    );
    if (users.length) warnings.push(`${users.map((u) => `${u.kind} ${u.name}`).join(', ')} still reference${users.length === 1 ? 's' : ''} ${s.kind} ${s.name}`);
  }
  const root = scopeRoot(ctx.paths, opts.scope);
  await undeployEntries(ctx, deps, opts.scope, removed, protectedFiles(root, lock, leaving), warnings);
  lock = reparent(lock, plan.kept);
  for (const k of plan.kept) warnings.push(`kept ${k.entry.kind} ${k.entry.name}: ${k.via ? `still needed by ${k.via.replace(':', ' ')}` : 'listed in the manifest'}`);

  for (const e of removed) {
    lock = removeEntry(lock, e.kind, e.name, e.origin);
    if (!e.via) {
      manifest = removeDep(manifest, e.kind, e.name);
      if (e.kind === 'mcp' && e.origin === 'registry') manifest = removeDep(manifest, e.kind, e.path);
    }
  }
  for (const m of manifestOnly) manifest = removeDep(manifest, m.kind, m.name);

  if (!ctx.flags.dryRun) {
    if (removed.length || plan.kept.length) await saveLock(lockFile, lock);
    if (JSON.stringify(manifest) !== manifestBefore) await saveManifest(manFile, manifest);
  }
  return { removed, warnings };
}
