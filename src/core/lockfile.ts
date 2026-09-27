import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { PalmError } from './errors.js';
import { readYamlFile } from './manifest.js';
import { KINDS, type Kind, type LockEntry, type Lockfile } from './types.js';

function same(e: LockEntry, kind: Kind, name: string, origin?: string): boolean {
  return e.kind === kind && e.name.toLowerCase() === name.toLowerCase() && (origin === undefined || e.origin === origin);
}

export async function loadLock(file: string): Promise<Lockfile> {
  const data = await readYamlFile(file);
  if (data === undefined || data === null) return { version: 1, entries: [] };
  if (typeof data !== 'object' || Array.isArray(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  const d = data as { version?: unknown; entries?: unknown };
  if (d.version !== undefined && d.version !== 1) {
    throw new PalmError('E_PARSE', `${file}: unsupported lockfile version ${String(d.version)}`, 'Upgrade palm.');
  }
  const entries = Array.isArray(d.entries) ? (d.entries as LockEntry[]) : [];
  for (const e of entries) {
    e.targets ??= [];
    e.files ??= [];
  }
  return { version: 1, entries };
}

const KEY_ORDER: Array<keyof LockEntry> = [
  'kind', 'name', 'origin', 'url', 'ref', 'sha', 'path', 'contentHash', 'installedAt', 'targets', 'files', 'merged', 'via',
];

function orderEntry(e: LockEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (e[k] !== undefined) out[k] = e[k];
  for (const [k, v] of Object.entries(e)) if (!(k in out) && v !== undefined) out[k] = v;
  if (Array.isArray(out.merged) && out.merged.length === 0) delete out.merged;
  return out;
}

export async function saveLock(file: string, lock: Lockfile): Promise<void> {
  const entries = [...lock.entries].sort(
    (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin),
  );
  const text =
    '# palm lockfile — generated, do not edit by hand.\n' +
    stringify({ version: 1, entries: entries.map(orderEntry) }, { lineWidth: 0 });
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
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

export function findEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): LockEntry | undefined {
  return lock.entries.find((e) => same(e, kind, name, origin));
}
