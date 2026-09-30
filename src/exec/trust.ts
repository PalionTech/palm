/**
 * Trust bookkeeping over lock entries (DESIGN.md section 7): consent is a hash in the entry's
 * `trust`, replayed silently while the unit's hash matches; a declined plugin hook stays quiet
 * until someone asks for it by name.
 */
import { short } from '../core/hash.js';
import type { ExecUnit, LockEntry, LockExec, Scope } from '../core/types.js';
import { withoutUndefined } from '../lib/object.js';
import { closureTree, commandAt, firstTarget } from './units.js';

/**
 * True when installing `unit` needs a person's consent: there is no lock entry, the entry
 * trusts no hash, or not this one. A declined entry needs none (it installs nothing and bare
 * installs stay quiet) unless the user asked for it by name (`explicit`).
 */
export function needsConsent(
  entry: LockEntry | undefined,
  unit: ExecUnit,
  opts: { explicit?: boolean } = {},
): boolean {
  if (!entry) return true;
  if (entry.declined && !opts.explicit) return false;
  return !(entry.trust ?? []).includes(unit.hash);
}

/**
 * What the lock records of a unit: one readable command per line (the first target's
 * rendering, as the harness file holds it), the closure (an in-repo one too, ruling E2) and
 * the hash.
 */
function lockExecOf(unit: ExecUnit): LockExec {
  const target = firstTarget(unit);
  const commands = unit.commands.map((c, i) => ({ id: c.id, command: commandAt(unit, target, i) }));
  const exec: LockExec = { commands, hash: unit.hash };
  const { root, files } = unit.closure;
  if (files.length) exec.closure = { root, files: files.length, tree: closureTree(files) };
  return exec;
}

/** `entry` with the unit's exec recorded and its hash trusted; a previous decline is lifted. */
export function withTrust(entry: LockEntry, unit: ExecUnit): LockEntry {
  return withoutUndefined({
    ...entry,
    exec: lockExecOf(unit),
    trust: [unit.hash],
    declined: undefined,
  });
}

/** `entry` marked declined: it installs nothing and holds no trust. */
export function withDeclined(entry: LockEntry): LockEntry {
  return withoutUndefined({ ...entry, trust: undefined, declined: true });
}

/**
 * V5 (ruling 30): the line after someone declined a changed program whose earlier version the
 * lock still trusts: `hook fmt: previous version stays active (trusted sha256:1b9e04c2); palm
 * remove acme hook:fmt removes it`. Undefined when nothing trusted stays on disk.
 */
export function previousStaysActive(
  entry: LockEntry | undefined,
  scope: Scope,
): string | undefined {
  const hash = entry?.exec?.hash;
  if (!entry || !hash || !(entry.trust ?? []).includes(hash)) return undefined;
  const remove = ['palm', 'remove', entry.source, `${entry.kind}:${entry.name}`];
  if (scope === 'global') remove.push('-g');
  return `${entry.kind} ${entry.name}: previous version stays active (trusted sha256:${short(hash, 8)}); ${remove.join(' ')} removes it`;
}
