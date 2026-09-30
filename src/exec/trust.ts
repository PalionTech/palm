/**
 * Trust bookkeeping over lock entries (DESIGN.md section 7): consent is a hash in the entry's
 * `trust`, replayed silently while the unit's hash matches. A declined plugin hook is no lock
 * entry: palm.yaml excludes it on the plugin entry (D28).
 */
import { short } from '../core/hash.js';
import type { ExecUnit, LockEntry, LockExec, Scope } from '../core/types.js';
import { withoutUndefined } from '../lib/object.js';
import { closureTree, commandAt, firstTarget } from './units.js';

/**
 * True when installing `unit` needs a person's consent: there is no lock entry, the entry
 * trusts no hash, or not this one.
 */
export function needsConsent(entry: LockEntry | undefined, unit: ExecUnit): boolean {
  return !(entry?.trust ?? []).includes(unit.hash);
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
  });
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
