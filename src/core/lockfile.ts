import { isRecord, withoutUndefined } from '../lib/object.js';
import { writeYamlFile } from '../lib/yaml.js';
import { PalmError } from './errors.js';
import { loadYaml } from './manifest.js';
import { KINDS, type Kind, type LockEntry, type Lockfile } from './types.js';

function same(e: LockEntry, kind: Kind, name: string, origin?: string): boolean {
  return (
    e.kind === kind &&
    e.name.toLowerCase() === name.toLowerCase() &&
    (origin === undefined || e.origin === origin)
  );
}

export async function loadLock(file: string): Promise<Lockfile> {
  const data = await loadYaml(file);
  if (data === undefined || data === null) return { version: 1, entries: [] };
  if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  if (data.version !== undefined && data.version !== 1) {
    throw new PalmError(
      'E_PARSE',
      `${file}: unsupported lockfile version ${String(data.version)}`,
      'Upgrade palm.',
    );
  }
  const entries = Array.isArray(data.entries) ? (data.entries as LockEntry[]) : [];
  for (const e of entries) {
    e.targets ??= [];
    e.files ??= [];
  }
  return { version: 1, entries };
}

const KEY_ORDER: Array<keyof LockEntry> = [
  'kind',
  'name',
  'origin',
  'url',
  'ref',
  'sha',
  'path',
  'contentHash',
  'installedAt',
  'targets',
  'files',
  'merged',
  'via',
];

/** The keys in KEY_ORDER, then any others; undefined values and an empty `merged` dropped. */
function orderEntry(e: LockEntry): Record<string, unknown> {
  const ordered = Object.fromEntries(KEY_ORDER.map((k) => [k, e[k]]));
  const out: Record<string, unknown> = withoutUndefined({ ...ordered, ...e });
  if (Array.isArray(out.merged) && out.merged.length === 0) delete out.merged;
  return out;
}

export async function saveLock(file: string, lock: Lockfile): Promise<void> {
  const entries = [...lock.entries].sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      a.name.localeCompare(b.name) ||
      a.origin.localeCompare(b.origin),
  );
  await writeYamlFile(
    file,
    { version: 1, entries: entries.map(orderEntry) },
    { preserveFrom: false, comment: 'palm lockfile — generated, do not edit by hand.' },
  );
}

/** Insert or replace the entry with the same kind+name+origin. Returns a new lockfile. */
export function upsertEntry(lock: Lockfile, entry: LockEntry): Lockfile {
  const idx = lock.entries.findIndex((e) => same(e, entry.kind, entry.name, entry.origin));
  const entries = [...lock.entries];
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  return { version: 1, entries };
}

/** Remove every entry with kind+name (and origin, when given). Returns a new lockfile. */
export function removeEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): Lockfile {
  return { version: 1, entries: lock.entries.filter((e) => !same(e, kind, name, origin)) };
}

export function findEntry(
  lock: Lockfile,
  kind: Kind,
  name: string,
  origin?: string,
): LockEntry | undefined {
  return lock.entries.find((e) => same(e, kind, name, origin));
}
