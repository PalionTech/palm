/**
 * One owner per entity and per file (E5, R5, K4, B1, L2, C5, Z7, Y9): two sources never install
 * an entity of the same kind and name into one scope, and no entry writes a file another entry
 * owns. A clash is E_CONFLICT naming the owner and `palm remove <owner> <kind:name>` as the fix;
 * `--force` does not apply, since it would give one file two owners that fight on every run.
 */
import type { LockEntry } from '../core/types.js';
import { entityId, lockId } from '../domain/entity-key.js';
import type { Prepared, Run } from './jobs.js';
import { failure, palmCommand } from './report.js';

/** `kind name from source`, for messages. */
function ownerLabel(e: { kind: string; name: string; source: string }): string {
  return `${e.kind} ${e.name} from ${e.source}`;
}

interface Owners {
  /** entity id (`kind:name`) → the entries that hold it. */
  entities: Map<string, LockEntry[]>;
  /** lock path → the entry that lists it. */
  files: Map<string, LockEntry>;
}

/** The lock's owners, without the entries this run removes (`leaving`, lock ids). */
function ownersOf(run: Run, leaving: ReadonlySet<string>): Owners {
  const out: Owners = { entities: new Map(), files: new Map() };
  for (const e of run.state.lock.entries) {
    if (leaving.has(lockId(e)) || e.declined) continue;
    out.entities.set(entityId(e), [...(out.entities.get(entityId(e)) ?? []), e]);
    for (const f of e.files) if (!out.files.has(f)) out.files.set(f, e);
  }
  return out;
}

/** Every file path the prepared entity would write, over its targets. */
function writtenPaths(p: Prepared): string[] {
  return Object.values(p.out.renders)
    .flatMap((r) => (r?.skipped ? [] : (r?.files ?? [])))
    .map((f) => f.path);
}

type Subject = { kind: LockEntry['kind']; name: string; source: string };

/** The entry that already holds this kind and name, or a file this entity would write. */
function clashOf(
  p: Prepared,
  owners: Owners,
  claimed: Map<string, Subject>,
): { owner: Subject; file?: string } | undefined {
  const own = lockId({ ...p.job.entity, source: p.job.source.name });
  const eid = entityId(p.job.entity);
  if (p.job.entity.kind !== 'plugin') {
    const held = (owners.entities.get(eid) ?? []).find((e) => lockId(e) !== own);
    const other = held ?? claimed.get(eid);
    if (other && lockId(other) !== own) return { owner: other };
  }
  for (const file of writtenPaths(p)) {
    const o = owners.files.get(file);
    if (o && lockId(o) !== own) return { owner: o, file };
  }
  return undefined;
}

function conflictFailure(run: Run, p: Prepared, clash: { owner: Subject; file?: string }) {
  const { owner, file } = clash;
  const subject = { kind: p.job.entity.kind, name: p.job.entity.name, source: p.job.source.name };
  const message = file
    ? `${file} belongs to ${ownerLabel(owner)}; one file has one owner`
    : `${owner.kind} ${owner.name} is already installed from ${owner.source}; a scope holds one ${owner.kind} ${owner.name}`;
  const hint = palmCommand(
    'remove',
    [owner.source, `${owner.kind}:${owner.name}`],
    run.state.paths.scope,
  );
  return failure(subject, 'E_CONFLICT', { message, hint });
}

/**
 * The prepared entities that clash with no other owner; each clash is a failure naming the
 * owner. `leaving` holds the lock ids this run removes (they own nothing any more). Within the
 * run, the first entity of a kind and name wins. Returns the lock ids refused.
 */
export function refuseConflicts(
  run: Run,
  prepared: Prepared[],
  leaving: ReadonlySet<string> = new Set(),
): { kept: Prepared[]; refused: Prepared[] } {
  const owners = ownersOf(run, leaving);
  const claimed = new Map<string, Subject>();
  const kept: Prepared[] = [];
  const refused: Prepared[] = [];
  for (const p of prepared) {
    const clash = clashOf(p, owners, claimed);
    if (clash) {
      run.result.failures.push(conflictFailure(run, p, clash));
      refused.push(p);
      continue;
    }
    kept.push(p);
    const { kind, name } = p.job.entity;
    if (kind !== 'plugin')
      claimed.set(entityId(p.job.entity), { kind, name, source: p.job.source.name });
  }
  return { kept, refused };
}
