import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Document, isMap, isNode, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';
import { PalmError } from './errors.js';
import { manifestKey } from './kinds.js';
import type { DepRef, DepSpec, Kind, Manifest, McpManifestEntry } from './types.js';

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
  if (!name) throw new PalmError('E_USAGE', `Invalid dependency "${spec}": missing name`, 'Expected <name>[@<origin>][#<ref>]');
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

const MCP_ENTRY_KEYS = ['transport', 'command', 'args', 'env', 'url', 'headers', 'registry', 'version'] as const;

/** True when the object is an MCP manifest entry rather than a plain DepRef. */
export function isMcpManifestEntry(dep: unknown): dep is McpManifestEntry {
  if (!dep || typeof dep !== 'object') return false;
  return MCP_ENTRY_KEYS.some((k) => (dep as Record<string, unknown>)[k] !== undefined);
}

function entryNames(entry: unknown): string[] {
  if (typeof entry === 'string') {
    try {
      return [parseDepRef(entry).name.toLowerCase()];
    } catch {
      return [];
    }
  }
  if (entry && typeof entry === 'object') {
    const e = entry as { name?: unknown; registry?: unknown };
    const names: string[] = [];
    if (typeof e.name === 'string') names.push(e.name.toLowerCase());
    if (typeof e.registry === 'string') names.push(e.registry.toLowerCase());
    return names;
  }
  return [];
}

function toManifestItem(dep: DepRef | McpManifestEntry): string | McpManifestEntry {
  if (isMcpManifestEntry(dep)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dep)) if (v !== undefined) out[k] = v;
    return out as unknown as McpManifestEntry;
  }
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
  return { ...m, [key]: next };
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
// YAML I/O (comment-preserving)
// ---------------------------------------------------------------------------

/** Read and parse a YAML file. Returns undefined when the file does not exist. */
export async function readYamlFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PalmError('E_IO', `Cannot read ${file}: ${(e as Error).message}`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new PalmError('E_PARSE', `Invalid YAML in ${file}: ${doc.errors[0]!.message}`);
  }
  return doc.toJS() ?? {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function nodeJS(node: unknown): unknown {
  return isNode(node) ? node.toJSON() : node;
}

function keyString(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

/** Update `node` in place to represent `value`, keeping nodes (and their comments) that did not change. */
function updateNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isNode(node) && deepEqual(nodeJS(node), value)) return node;
  if (isSeq(node) && Array.isArray(value)) {
    const old = node.items;
    const used = new Set<number>();
    const matched: Array<unknown> = value.map((v) => {
      const i = old.findIndex((n, j) => !used.has(j) && deepEqual(nodeJS(n), v));
      if (i < 0) return undefined;
      used.add(i);
      return old[i];
    });
    node.items = value.map((v, i) => {
      if (matched[i] !== undefined) return matched[i];
      // Positional fallback keeps comments on an item that was edited in place.
      if (i < old.length && !used.has(i) && (isMap(old[i]) || isSeq(old[i]))) {
        used.add(i);
        return updateNode(doc, old[i], v);
      }
      return doc.createNode(v);
    }) as typeof node.items;
    return node;
  }
  if (isMap(node) && isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    node.items = node.items.filter((p) => keys.includes(keyString(p.key)));
    for (const k of keys) {
      const pair = node.items.find((p) => keyString(p.key) === k);
      if (pair) pair.value = updateNode(doc, pair.value, value[k]) as YamlNode;
      else node.items.push(doc.createPair(k, value[k]) as (typeof node.items)[number]);
    }
    return node;
  }
  return doc.createNode(value);
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

/**
 * Write `value` as YAML. When the file already exists, its comments, key
 * order and unchanged nodes are preserved (yaml Document API).
 */
export async function writeYamlPreserving(file: string, value: unknown, opts: { flowKeys?: string[] } = {}): Promise<void> {
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    existing = undefined;
  }
  let out: string | undefined;
  if (existing !== undefined && existing.trim()) {
    const doc = parseDocument(existing);
    if (doc.errors.length === 0) {
      doc.contents = updateNode(doc, doc.contents, value) as typeof doc.contents;
      out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
    }
  }
  if (out === undefined) {
    const doc = new Document(value);
    if (isMap(doc.contents)) {
      for (const p of doc.contents.items) {
        if (opts.flowKeys?.includes(keyString(p.key)) && isSeq(p.value)) p.value.flow = true;
      }
    }
    out = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  }
  await atomicWrite(file, out);
}

// ---------------------------------------------------------------------------
// Manifest load/save
// ---------------------------------------------------------------------------

const MANIFEST_ORDER = ['targets', 'origins', 'skills', 'agents', 'instructions', 'commands', 'hooks', 'mcp', 'plugins'];

function orderManifest(m: Manifest): Record<string, unknown> {
  const src = m as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of MANIFEST_ORDER) if (src[k] !== undefined) out[k] = src[k];
  for (const k of Object.keys(src)) if (!(k in out) && src[k] !== undefined) out[k] = src[k];
  return out;
}

export async function loadManifest(file: string): Promise<Manifest> {
  const data = await readYamlFile(file);
  if (data === undefined || data === null) return {};
  if (!isPlainObject(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  for (const k of MANIFEST_ORDER) {
    if (data[k] !== undefined && data[k] !== null && !Array.isArray(data[k])) {
      throw new PalmError('E_PARSE', `${file}: "${k}" must be a list`);
    }
    if (data[k] === null) delete data[k];
  }
  return data as Manifest;
}

export async function saveManifest(file: string, m: Manifest): Promise<void> {
  await writeYamlPreserving(file, orderManifest(m), { flowKeys: ['targets'] });
}
