import { errnoCode } from '../lib/fs.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { readYamlFile, writeYamlFile } from '../lib/yaml.js';
import { messageOf, PalmError } from './errors.js';
import { manifestKey } from './kinds.js';
import type { DepRef, DepSpec, Kind, Manifest, McpManifestEntry } from './types.js';

/** @deprecated wave1: import from lib */
export { deepEqual } from '../lib/object.js';

// ---------------------------------------------------------------------------
// Dependency strings
// ---------------------------------------------------------------------------

/** Parse `<name>[@<origin>][#<ref>]` (DESIGN.md §3). Registry names like `io.github.x/y` pass through. */
export function parseDepRef(spec: string): DepRef {
  let rest = spec.trim();
  let ref: string | undefined;
  const hash = rest.lastIndexOf('#');
  if (hash >= 0) {
    ref = rest.slice(hash + 1).trim() || undefined;
    rest = rest.slice(0, hash);
  }
  let origin: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0 && !rest.slice(at + 1).includes('/')) {
    origin = rest.slice(at + 1).trim() || undefined;
    rest = rest.slice(0, at);
  }
  const name = rest.trim();
  if (!name)
    throw new PalmError(
      'E_USAGE',
      `Invalid dependency "${spec}": missing name`,
      'Expected <name>[@<origin>][#<ref>]',
    );
  const out: DepRef = { name };
  if (origin) out.origin = origin;
  if (ref) out.ref = ref;
  return out;
}

export function formatDepRef(ref: DepRef): string {
  return `${ref.name}${ref.origin ? `@${ref.origin}` : ''}${ref.ref ? `#${ref.ref}` : ''}`;
}

export function normalizeDep(spec: DepSpec): DepRef {
  if (typeof spec === 'string') return parseDepRef(spec);
  if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string' || !spec.name) {
    throw new PalmError('E_PARSE', `Invalid dependency entry: ${JSON.stringify(spec)}`);
  }
  const out: DepRef = { name: spec.name };
  if (spec.origin) out.origin = spec.origin;
  if (spec.ref) out.ref = spec.ref;
  return out;
}

const MCP_ENTRY_KEYS = [
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'registry',
  'version',
] as const;

/** True when the object is an MCP manifest entry rather than a plain DepRef. */
export function isMcpManifestEntry(dep: unknown): dep is McpManifestEntry {
  return isRecord(dep) && MCP_ENTRY_KEYS.some((k) => dep[k] !== undefined);
}

function entryNames(entry: unknown): string[] {
  if (typeof entry === 'string') {
    try {
      return [parseDepRef(entry).name.toLowerCase()];
    } catch {
      return [];
    }
  }
  if (isRecord(entry)) {
    const names: string[] = [];
    if (typeof entry.name === 'string') names.push(entry.name.toLowerCase());
    if (typeof entry.registry === 'string') names.push(entry.registry.toLowerCase());
    return names;
  }
  return [];
}

function toManifestItem(dep: DepRef | McpManifestEntry): string | McpManifestEntry {
  if (isMcpManifestEntry(dep)) return withoutUndefined(dep);
  return formatDepRef(dep);
}

/** Add or replace (same name, case-insensitive) a dependency in the kind's section. Returns a new manifest. */
export function addDep(m: Manifest, kind: Kind, dep: DepRef | McpManifestEntry): Manifest {
  const key = manifestKey(kind);
  const list = [...((m[key] as unknown[] | undefined) ?? [])];
  const item = toManifestItem(dep);
  const wanted = new Set(entryNames(dep));
  if (!isMcpManifestEntry(dep)) wanted.add(dep.name.toLowerCase());
  const idx = list.findIndex((e) => entryNames(e).some((n) => wanted.has(n)));
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  return { ...m, [key]: list };
}

export function removeDep(m: Manifest, kind: Kind, name: string): Manifest {
  const key = manifestKey(kind);
  const list = (m[key] as unknown[] | undefined) ?? [];
  const lower = name.toLowerCase();
  const next = list.filter((e) => !entryNames(e).includes(lower));
  if (next.length === list.length) return m;
  const out: Manifest = { ...m, [key]: next };
  // An emptied section disappears instead of lingering as `agents: []`.
  if (next.length === 0) delete (out as Record<string, unknown>)[key];
  return out;
}

export function listDeps(m: Manifest, kind: Kind): Array<DepRef | McpManifestEntry> {
  const key = manifestKey(kind);
  const list = (m[key] as unknown[] | undefined) ?? [];
  const out: Array<DepRef | McpManifestEntry> = [];
  for (const e of list) {
    if (kind === 'mcp' && isMcpManifestEntry(e)) out.push(e);
    else out.push(normalizeDep(e as DepSpec));
  }
  return out;
}

// ---------------------------------------------------------------------------
// YAML I/O
// ---------------------------------------------------------------------------

/**
 * Reads and parses a palm YAML file (manifest, lockfile, config); undefined when it is
 * missing or empty. Read failures are E_IO, invalid YAML is E_PARSE.
 */
export async function loadYaml(file: string): Promise<unknown> {
  try {
    return await readYamlFile(file);
  } catch (e) {
    if (errnoCode(e)) throw new PalmError('E_IO', `Cannot read ${file}: ${messageOf(e)}`);
    throw new PalmError('E_PARSE', messageOf(e));
  }
}

// ---------------------------------------------------------------------------
// Manifest load/save
// ---------------------------------------------------------------------------

const MANIFEST_ORDER = [
  'targets',
  'origins',
  'skills',
  'agents',
  'instructions',
  'commands',
  'hooks',
  'mcp',
  'plugins',
];

/** The sections in MANIFEST_ORDER, then any other keys; undefined values dropped. */
function orderManifest(m: Manifest): Record<string, unknown> {
  const src = m as Record<string, unknown>;
  return withoutUndefined({
    ...Object.fromEntries(MANIFEST_ORDER.map((k) => [k, src[k]])),
    ...src,
  });
}

export async function loadManifest(file: string): Promise<Manifest> {
  const data = await loadYaml(file);
  if (data === undefined || data === null) return {};
  if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  for (const k of MANIFEST_ORDER) {
    if (data[k] !== undefined && data[k] !== null && !Array.isArray(data[k])) {
      throw new PalmError('E_PARSE', `${file}: "${k}" must be a list`);
    }
    if (data[k] === null) delete data[k];
  }
  return data as Manifest;
}

export async function saveManifest(file: string, m: Manifest): Promise<void> {
  await writeYamlFile(file, orderManifest(m), { flowKeys: ['targets'] });
}
