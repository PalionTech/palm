/**
 * palm.lock.yaml v3 on disk (DESIGN.md section 4): the deterministic writer (key order, sorting,
 * flow style) and the reader's checks, including the 0.1 format detection. Lock (lock.ts) is
 * the collection built on it.
 */
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import {
  type EntityRef,
  KINDS,
  type LegacyLockfile,
  type LockEntry,
  type LockExec,
  type Lockfile,
  type LockMerged,
  type LockSource,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { stringifyYaml, type YamlPath } from '../lib/yaml.js';

export const LOCK_VERSION = 3;

const LOCK_COMMENT = 'palm lockfile: written by palm, do not edit by hand.';

const ENTRY_KEYS = [
  'kind',
  'name',
  'source',
  'via',
  'path',
  'content',
  'render',
  'files',
  'merged',
  'exec',
  'trust',
  'notes',
  'targets',
  'at',
  'carrier',
  'deps',
] as const;
const SOURCE_KEYS = [
  'url',
  'root',
  'path',
  'ref',
  'resolved',
  'sha',
  'tree',
  'layout',
  'descriptor',
];
const MERGED_KEYS = ['file', 'at', 'id', 'key'];
const EXEC_KEYS = ['commands', 'closure', 'hash'];

/** Code-point order (locale-independent, so every machine writes the same lock). */
export function compareText(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** `value`'s defined keys: `keys` first in that order, then any others in code-point order. */
function ordered(value: object, keys: readonly string[]): Record<string, unknown> {
  const src = value as Record<string, unknown>;
  const rest = Object.keys(src)
    .filter((k) => !keys.includes(k))
    .sort(compareText);
  const out: Record<string, unknown> = {};
  for (const k of [...keys, ...rest]) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function uniqueSorted(list: readonly string[]): string[] {
  return [...new Set(list)].sort(compareText);
}

/** A per-target record in TARGET_IDS order; undefined when it has no target. */
function byTarget<T>(
  rec: Partial<Record<TargetId, T>> | undefined,
): Partial<Record<TargetId, T>> | undefined {
  if (!rec) return undefined;
  const out: Partial<Record<TargetId, T>> = {};
  for (const t of TARGET_IDS) if (rec[t] !== undefined) out[t] = rec[t];
  return Object.keys(out).length ? out : undefined;
}

function byKindName(a: EntityRef, b: EntityRef): number {
  return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || compareText(a.name, b.name);
}

function normalizeMerged(
  merged: readonly LockMerged[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!merged?.length) return undefined;
  const sorted = [...merged].sort(
    (a, b) => compareText(a.file, b.file) || compareText(a.at, b.at) || compareText(a.id, b.id),
  );
  return sorted.map((m) => ordered(m, MERGED_KEYS));
}

function normalizeExec(exec: LockExec | undefined): Record<string, unknown> | undefined {
  if (!exec) return undefined;
  const commands = [...exec.commands]
    .sort((a, b) => compareText(a.id, b.id))
    .map((c) => ordered(c, ['id', 'command']));
  const closure = exec.closure ? ordered(exec.closure, ['root', 'files', 'tree']) : undefined;
  return ordered({ ...exec, commands, closure }, EXEC_KEYS);
}

/** An entry as written: keys in order, lists sorted, empty optional lists dropped. */
function normalizeEntry(e: LockEntry): LockEntry {
  const deps = e.deps
    ? [...e.deps].sort(byKindName).map((d) => ordered(d, ['kind', 'name']))
    : undefined;
  const out = {
    ...e,
    render: byTarget(e.render) ?? {},
    files: uniqueSorted(e.files ?? []),
    merged: normalizeMerged(e.merged),
    exec: normalizeExec(e.exec),
    trust: e.trust?.length ? uniqueSorted(e.trust) : undefined,
    notes: e.notes?.length ? [...new Set(e.notes)] : undefined,
    targets: e.targets?.length ? TARGET_IDS.filter((t) => e.targets?.includes(t)) : undefined,
    carrier: byTarget(e.carrier),
    deps: e.kind === 'plugin' || deps?.length ? deps : undefined,
  };
  return ordered(out, ENTRY_KEYS) as unknown as LockEntry;
}

/** Kind (KINDS order), name (any case), source, then name: code points, so every machine sorts alike. */
function byKindNameSource(a: LockEntry, b: LockEntry): number {
  return (
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.source, b.source) ||
    compareText(a.name, b.name)
  );
}

/** The plain `Lockfile` in written form: sources by name, entries sorted and normalized. */
export function normalizeLock(
  sources: Record<string, LockSource>,
  entries: readonly LockEntry[],
): Lockfile {
  const names = Object.keys(sources).sort(compareText);
  return {
    version: LOCK_VERSION,
    sources: Object.fromEntries(
      names.map((n) => [n, ordered(sources[n] as LockSource, SOURCE_KEYS)]),
    ),
    entries: [...entries].sort(byKindNameSource).map(normalizeEntry),
  };
}

const FLOW_ENTRY_KEYS = new Set(['render', 'trust', 'targets', 'carrier']);

/** The collections written in flow style: short per-entry maps and lists, and list items of `merged`, `deps` and `exec.commands`. */
function isFlow(p: YamlPath): boolean {
  const [top, , key, sub, sub2] = p;
  if (top === 'sources') return key === 'layout' && p.length === 3;
  if (top !== 'entries' || typeof key !== 'string') return false;
  if (p.length === 3) return FLOW_ENTRY_KEYS.has(key);
  if (p.length === 4)
    return key === 'merged' || key === 'deps' || (key === 'exec' && sub === 'closure');
  return key === 'exec' && sub === 'commands' && typeof sub2 === 'number' && p.length === 5;
}

/** The exact text `Lock.save` writes for normalized data (LF line ends, a header comment). */
export function lockText(data: Lockfile): string {
  return stringifyYaml(data, { flow: isFlow, comment: LOCK_COMMENT });
}

function badEntry(file: string, i: number, why: string): PalmError {
  return new PalmError(
    'E_PARSE',
    `${path.basename(file)}: entry ${i + 1} ${why}`,
    'restore palm.lock.yaml from git, then run palm install',
  );
}

const REQUIRED_STRINGS = ['name', 'source', 'path', 'content'] as const;

/** One entry of a v3 lock, checked: kind, name, source, path, content and render are required. */
export function validEntry(file: string, i: number, raw: unknown): LockEntry {
  if (!isRecord(raw)) throw badEntry(file, i, 'is not a mapping');
  if (!KINDS.includes(raw.kind as LockEntry['kind'])) throw badEntry(file, i, 'needs a known kind');
  for (const k of REQUIRED_STRINGS)
    if (typeof raw[k] !== 'string') throw badEntry(file, i, `needs a ${k}`);
  if (!isRecord(raw.render)) throw badEntry(file, i, 'needs a render map');
  if (
    raw.files !== undefined &&
    !(Array.isArray(raw.files) && raw.files.every((f) => typeof f === 'string'))
  )
    throw badEntry(file, i, 'has a files list that is not a list of paths');
  return { ...raw, files: (raw.files as string[] | undefined) ?? [] } as unknown as LockEntry;
}

/** The `sources` map of a v3 lock, checked. */
export function validSources(file: string, raw: unknown): Record<string, LockSource> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw))
    throw new PalmError('E_PARSE', `${path.basename(file)}: sources must be a mapping`);
  for (const [name, s] of Object.entries(raw)) {
    if (!isRecord(s))
      throw new PalmError('E_PARSE', `${path.basename(file)}: source "${name}" must be a mapping`);
  }
  return raw as Record<string, LockSource>;
}

/** The version a lock document declares: 1 for a versionless lock with entries (palm 0.1's first format). */
export function versionOf(data: Record<string, unknown>): unknown {
  if (data.version === undefined && Array.isArray(data.entries)) return 1;
  return data.version;
}

/** E_USAGE for a 0.1 lock (the hint is `palm migrate`), E_PARSE for an unknown version. */
export function assertV3(file: string, version: unknown): void {
  if (version === undefined || version === LOCK_VERSION) return;
  const name = path.basename(file);
  if (version === 1 || version === 2)
    throw new PalmError('E_USAGE', `${name} is version ${version} (palm 0.1)`, 'palm migrate');
  throw new PalmError(
    'E_PARSE',
    `${name} is version ${String(version)}, which this palm does not read`,
    'npm install -g @paliontech/palm@latest',
  );
}

/** A 0.1 lock document as data (migrate only). */
export function legacyLock(data: Record<string, unknown>, version: 1 | 2): LegacyLockfile {
  const out: LegacyLockfile = {
    version,
    entries: (Array.isArray(data.entries) ? data.entries : []).filter(
      isRecord,
    ) as unknown as LegacyLockfile['entries'],
  };
  if (Array.isArray(data.targets))
    out.targets = TARGET_IDS.filter((t) => (data.targets as unknown[]).includes(t));
  if (Array.isArray(data.createdDirs))
    out.createdDirs = data.createdDirs.filter((d): d is string => typeof d === 'string');
  return out;
}
