/**
 * Before palm deletes an entry's files it checks that the person did not change them (DESIGN §6
 * "Remove" and "Bare install"): under -g against the hashes in applied.yaml, in a project
 * against the render recomputed from the cache at the locked sha. A file that differs is kept.
 */
import { diskContentHash } from '../core/hash.js';
import type { Entity, LockEntry, TargetId } from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import { fileStates, fragmentStates, ownedFragments } from './diff.js';
import { recordedPolicy } from './entries.js';
import type { Run } from './jobs.js';
import { type RenderOutput, renderEntity } from './render.js';
import { resolveSource } from './resolve.js';
import { lockedSource } from './scope.js';
import { MANIFEST_SOURCE, manifestSource, mcpConfigOf, mcpEntity, sourceRefOf } from './sources.js';

/** Global scope: files whose disk content is not what palm last wrote on this machine. */
async function editedAgainstApplied(run: Run, entry: LockEntry): Promise<string[]> {
  const { paths, applied } = run.state;
  const edited: string[] = [];
  for (const f of entry.files) {
    const abs = paths.abs(f);
    const disk = await diskContentHash(abs);
    if (disk !== undefined && disk !== applied?.fileHash(abs)) edited.push(f);
  }
  return edited;
}

async function locate(run: Run, entry: LockEntry) {
  if (entry.source === MANIFEST_SOURCE) {
    const e = run.state.manifest.mcp[entry.name];
    return e
      ? { ...manifestSource(run.state), entity: mcpEntity(mcpConfigOf(entry.name, e)) }
      : undefined;
  }
  const ref = sourceRefOf(run.state, entry.source);
  if (!ref) return undefined;
  const sha = lockedSource(run.state, entry.source)?.sha;
  const r = await resolveSource({
    ctx: run.ctx,
    deps: run.deps,
    state: run.state,
    ref,
    ...(sha ? { sha } : {}),
  });
  const entity: Entity | undefined = r.index.entities.find(
    (e) => e.kind === entry.kind && sameName(e.name, entry.name),
  );
  return entity ? { ref, checkout: r.checkout, entity } : undefined;
}

/**
 * The secret policy the entry was rendered with (`secrets: literal` recorded on the entry, Y19),
 * so a literal entry hashes as it was written; this run's `--secrets` does not change the past.
 */
function lockedPolicy(run: Run, entry: LockEntry) {
  return recordedPolicy(run.state, entry) ?? 'env-ref';
}

/**
 * As `renderLocked`, but a source palm cannot reach rejects with its error (`E_NETWORK` when
 * the commit is not cached and `--offline` is set), so `check` can tell an empty cache from a
 * difference (E13). Undefined when the entity is gone from the source.
 */
export async function renderLockedOrThrow(
  run: Run,
  entry: LockEntry,
  targets: TargetId[] = Object.keys(entry.render) as TargetId[],
): Promise<(RenderOutput & { entity: Entity }) | undefined> {
  const found = await locate(run, entry);
  if (!found) return undefined;
  const out = await renderEntity(run.ctx, run.deps, run.state, {
    entity: found.entity,
    source: found.ref,
    checkout: found.checkout,
    targets,
    policy: lockedPolicy(run, entry),
  });
  return { ...out, entity: found.entity };
}

/**
 * The entry rendered again as the lock recorded it: at the locked sha from the cache (fetched
 * when missing), for the entry's targets (or `targets`). Undefined when the source or the
 * entity is gone.
 */
export async function renderLocked(
  run: Run,
  entry: LockEntry,
  targets?: TargetId[],
): Promise<(RenderOutput & { entity: Entity }) | undefined> {
  return renderLockedOrThrow(run, entry, targets).catch(() => undefined);
}

/** Project scope: files and fragments that differ from the render the lock recorded. */
async function editedAgainstRender(run: Run, entry: LockEntry): Promise<string[] | undefined> {
  const out = await renderLocked(run, entry);
  if (!out) return undefined;
  const edited: string[] = [];
  for (const id of Object.keys(entry.render) as TargetId[]) {
    const r = out.renders[id];
    if (!r || r.hash !== entry.render[id]) return undefined;
    for (const [p, s] of await fileStates(run.state.paths, r)) if (s === 'modified') edited.push(p);
    for (const [k, s] of await fragmentStates(run.state.paths, r, ownedFragments(entry)))
      if (s === 'changed') edited.push(k);
  }
  return [...new Set(edited)];
}

/**
 * The lock paths (and `file#at#key` fragments) of `entry` the person changed since palm wrote
 * them; undefined when palm cannot tell (the source cannot be rendered as locked).
 */
export async function editedPaths(run: Run, entry: LockEntry): Promise<string[] | undefined> {
  if (!entry.files.length && !entry.merged?.length) return [];
  if (run.state.paths.scope === 'global' && run.state.applied)
    return editedAgainstApplied(run, entry);
  return editedAgainstRender(run, entry);
}
