/**
 * Trust bookkeeping over lock entries (DESIGN.md section 7): consent is a hash in the entry's
 * `trust`, replayed silently while the unit's hash matches; a declined plugin hook stays quiet
 * until someone asks for it by name.
 */
import type { ExecUnit, LockEntry, LockExec } from '../core/types.js';
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
 * rendering, as the harness file holds it), the closure and the hash.
 */
function lockExecOf(unit: ExecUnit): LockExec {
  const target = firstTarget(unit);
  const commands = unit.commands.map((c, i) => ({ id: c.id, command: commandAt(unit, target, i) }));
  const exec: LockExec = { commands, hash: unit.hash };
  const { root, inPlace, files } = unit.closure;
  if (!inPlace && files.length)
    exec.closure = { root, files: files.length, tree: closureTree(files) };
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
