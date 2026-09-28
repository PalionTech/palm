/** facade: prefer src/domain (Lock in domain/lock.ts). */
import { Lock } from '../domain/lock.js';
import type { Kind, LockEntry, Lockfile } from './types.js';

export async function loadLock(file: string): Promise<Lockfile> {
  return (await Lock.load(file)).toJSON();
}

export async function saveLock(file: string, lock: Lockfile): Promise<void> {
  await Lock.from(lock).save(file);
}

/** Insert or replace the entry with the same kind+name+origin. Returns a new lockfile. */
export function upsertEntry(lock: Lockfile, entry: LockEntry): Lockfile {
  return Lock.from(lock).upsert(entry).toJSON();
}

/** Remove every entry with kind+name (and origin, when given). Returns a new lockfile. */
export function removeEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): Lockfile {
  return Lock.from(lock).remove({ kind, name, origin }).toJSON();
}

export function findEntry(
  lock: Lockfile,
  kind: Kind,
  name: string,
  origin?: string,
): LockEntry | undefined {
  return Lock.from(lock).find({ kind, name }, origin);
}
