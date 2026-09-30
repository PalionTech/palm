/**
 * `$PALM_HOME/applied.yaml` (DESIGN.md sections 2 and 4): the global lock as last applied on
 * this machine, with real paths and per-file hashes. A bare `palm install -g` diffs the lock
 * against it, so a removal that arrives through a pulled global lock reaches every machine.
 */
import { messageOf } from '../core/errors.js';
import type { AppliedRecord } from '../core/types.js';
import { writeFileAtomic } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { stringifyYaml } from '../lib/yaml.js';
import { lockId } from './entity-key.js';
import type { Lock } from './lock.js';
import { compareText } from './lock-format.js';
import type { ScopePaths } from './scope-paths.js';
import { loadYaml } from './yaml-file.js';

const COMMENT =
  'palm: what this machine holds for the global scope. Written by palm; never commit it.';

function emptyRecord(): AppliedRecord {
  return { lockHash: '', files: [], merged: [], homes: {} };
}

/** True when `v` has the shape of an AppliedRecord. */
function isAppliedRecord(v: unknown): v is AppliedRecord {
  if (!isRecord(v) || typeof v.lockHash !== 'string' || !isRecord(v.homes)) return false;
  const files = v.files;
  const merged = v.merged;
  return (
    Array.isArray(files) &&
    files.every((f) => isRecord(f) && typeof f.path === 'string' && typeof f.hash === 'string') &&
    Array.isArray(merged) &&
    merged.every((m) => isRecord(m) && typeof m.file === 'string' && typeof m.entry === 'string')
  );
}

export class Applied {
  private constructor(
    private readonly rec: AppliedRecord,
    private readonly problems: readonly string[] = [],
  ) {}

  /** Reads applied.yaml: empty when missing; unreadable or malformed is empty too, with a `warnings()` line. */
  static async load(file: string): Promise<Applied> {
    let data: unknown;
    try {
      data = await loadYaml(file);
    } catch (e) {
      return new Applied(emptyRecord(), [`ignored ${file}: ${messageOf(e)}`]);
    }
    if (data === undefined || data === null) return new Applied(emptyRecord());
    if (!isAppliedRecord(data))
      return new Applied(emptyRecord(), [`ignored ${file}: it is not a record palm wrote`]);
    return new Applied(data);
  }

  /**
   * The record of `lock` applied through `paths`: every file with its real path and the hash of
   * what was written (`hashes`, by absolute path; a file without one is recorded with `''`),
   * every merged fragment with its absolute file, the lock's hash and the token homes.
   */
  static fromLock(lock: Lock, paths: ScopePaths, hashes: Map<string, string>): Applied {
    const files: AppliedRecord['files'] = [];
    const merged: AppliedRecord['merged'] = [];
    for (const e of lock.entries) {
      for (const f of e.files) {
        const abs = paths.abs(f);
        files.push({ path: abs, hash: hashes.get(abs) ?? '' });
      }
      for (const m of e.merged ?? [])
        merged.push({ ...m, file: paths.abs(m.file), entry: lockId(e) });
    }
    files.sort((a, b) => compareText(a.path, b.path));
    merged.sort(
      (a, b) => compareText(a.file, b.file) || compareText(a.at, b.at) || compareText(a.key, b.key),
    );
    return new Applied({ lockHash: lock.hash(), files, merged, homes: paths.homes() });
  }

  /** Writes applied.yaml (mode 0600: it names files in the user's home). */
  async save(file: string): Promise<void> {
    await writeFileAtomic(file, stringifyYaml(this.rec, { comment: COMMENT }), { mode: 0o600 });
  }

  get record(): AppliedRecord {
    return this.rec;
  }

  /** The hash palm wrote to `abs` on this machine; undefined when it wrote none. */
  fileHash(abs: string): string | undefined {
    return this.rec.files.find((f) => f.path === abs)?.hash || undefined;
  }

  merged(): AppliedRecord['merged'] {
    return [...this.rec.merged];
  }

  /** Why the file on disk was ignored, when it was. */
  warnings(): string[] {
    return [...this.problems];
  }
}
