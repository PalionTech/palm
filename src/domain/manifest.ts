import { messageOf, PalmError } from '../core/errors.js';
import { manifestKey } from '../core/kinds.js';
import type {
  DepRef as DepRefData,
  DepSpec,
  Kind,
  LockEntry,
  Manifest as ManifestData,
  McpManifestEntry,
  OriginSpec,
  TargetId,
} from '../core/types.js';
import { errnoCode } from '../lib/fs.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { readYamlFile, writeYamlFile } from '../lib/yaml.js';
import { DepRef, sameName } from './dep-ref.js';

/** One dependency as the manifest lists it: a reference, or (MCP only) an inline definition. */
export type ManifestDep = DepRef | McpManifestEntry;

/** What a manifest dependency is matched against: an installed lock entry. */
export type Installed = Pick<LockEntry, 'kind' | 'name' | 'origin' | 'path'>;

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

/** True when the object is an MCP manifest entry rather than a plain dependency reference. */
export function isMcpManifestEntry(dep: unknown): dep is McpManifestEntry {
  return isRecord(dep) && MCP_ENTRY_KEYS.some((k) => dep[k] !== undefined);
}

/**
 * Does the installed entry realise the manifest dependency (refs ignored)? Names compare
 * case-insensitively; registry MCP servers are listed under their registry name
 * (`io.github.upstash/context7`) but locked under their config key, with the registry name
 * in the entry's `path`.
 */
export function depMatches(kind: Kind, dep: DepRefData | McpManifestEntry, e: Installed): boolean {
  if (e.kind !== kind) return false;
  if (sameName(dep.name, e.name)) return true;
  if (kind !== 'mcp' || e.origin !== 'registry') return false;
  const registry = isMcpManifestEntry(dep) ? dep.registry : undefined;
  return [registry, dep.name].some((r) => r !== undefined && sameName(r, e.path));
}

/** Lower-cased names a raw manifest item answers to (name, and registry name for MCP). */
function itemNames(item: unknown): string[] {
  if (typeof item === 'string') {
    try {
      return [DepRef.parse(item).name.toLowerCase()];
    } catch {
      return [];
    }
  }
  if (!isRecord(item)) return [];
  return [item.name, item.registry]
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.toLowerCase());
}

/** The manifest form of a dependency: `name@origin#ref`, or the MCP entry without undefined keys. */
function toItem(dep: DepRefData | McpManifestEntry | DepSpec): string | McpManifestEntry {
  if (isMcpManifestEntry(dep)) return withoutUndefined(dep);
  return DepRef.from(dep).toString();
}

const SECTION_KEYS = [
  'skills',
  'agents',
  'instructions',
  'commands',
  'hooks',
  'mcp',
  'plugins',
] as const;
const ORDER = ['targets', 'origins', ...SECTION_KEYS];

/** The sections in canonical order, then any other keys; undefined values dropped. */
function ordered(m: ManifestData): Record<string, unknown> {
  const src = m as Record<string, unknown>;
  return withoutUndefined({ ...Object.fromEntries(ORDER.map((k) => [k, src[k]])), ...src });
}

function validated(file: string, data: unknown): ManifestData {
  if (data === undefined || data === null) return {};
  if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  for (const k of ORDER) {
    if (data[k] !== undefined && data[k] !== null && !Array.isArray(data[k])) {
      throw new PalmError('E_PARSE', `${file}: "${k}" must be a list`);
    }
    if (data[k] === null) delete data[k];
  }
  return data as ManifestData;
}

/**
 * palm.yaml: targets, project origins and one dependency list per kind. Mutating methods
 * change this object and return it; untouched sections stay shared with the loaded data.
 * `toJSON()` is the plain `Manifest` data (so `JSON.stringify` works for change detection).
 */
export class Manifest {
  private data: ManifestData;

  private constructor(data: ManifestData) {
    this.data = data;
  }

  /** Wraps plain manifest data (shallow copy: the input object is never changed). */
  static of(data: ManifestData = {}): Manifest {
    return new Manifest({ ...data });
  }

  /** Reads palm.yaml; an empty manifest when the file is missing. */
  static async load(file: string): Promise<Manifest> {
    return new Manifest(validated(file, await loadYaml(file)));
  }

  /** Writes palm.yaml, patching the existing file so comments and key order survive. */
  async save(file: string): Promise<void> {
    await writeYamlFile(file, ordered(this.data), { flowKeys: ['targets'] });
  }

  get targets(): TargetId[] | undefined {
    return this.data.targets;
  }

  setTargets(targets: TargetId[]): this {
    this.data = { ...this.data, targets };
    return this;
  }

  get origins(): Array<string | OriginSpec> | undefined {
    return this.data.origins;
  }

  private items(kind: Kind): unknown[] {
    return (this.data[manifestKey(kind)] as unknown[] | undefined) ?? [];
  }

  private setItems(kind: Kind, items: unknown[]): void {
    const key = manifestKey(kind);
    const next = { ...this.data, [key]: items } as Record<string, unknown>;
    // An emptied section disappears instead of lingering as `agents: []`.
    if (items.length === 0) delete next[key];
    this.data = next as ManifestData;
  }

  /** The kind's dependencies: references, plus inline entries in the `mcp` section. */
  deps(kind: Kind): ManifestDep[] {
    return this.items(kind).map((e) =>
      kind === 'mcp' && isMcpManifestEntry(e) ? e : DepRef.from(e as DepSpec),
    );
  }

  /** True when the kind's section lists `name` (or, for MCP, a registry name) in any case. */
  hasDep(kind: Kind, name: string): boolean {
    const lower = name.toLowerCase();
    return this.items(kind).some((e) => itemNames(e).includes(lower));
  }

  /** The dependency that the installed entry realises, if the manifest lists it directly. */
  depFor(e: Installed): ManifestDep | undefined {
    return this.deps(e.kind).find((d) => depMatches(e.kind, d, e));
  }

  /** True when the manifest lists the installed entry directly. */
  lists(e: Installed): boolean {
    return this.depFor(e) !== undefined;
  }

  /** Adds the dependency, or replaces the one with the same name (case-insensitive). */
  addDep(kind: Kind, dep: DepRefData | McpManifestEntry | DepSpec): this {
    const list = [...this.items(kind)];
    const item = toItem(dep);
    const wanted = new Set(itemNames(item));
    const at = list.findIndex((e) => itemNames(e).some((n) => wanted.has(n)));
    if (at >= 0) list[at] = item;
    else list.push(item);
    this.setItems(kind, list);
    return this;
  }

  /** Drops every dependency named `name` (or, for MCP, with that registry name). */
  removeDep(kind: Kind, name: string): this {
    const lower = name.toLowerCase();
    const list = this.items(kind);
    const next = list.filter((e) => !itemNames(e).includes(lower));
    if (next.length !== list.length) this.setItems(kind, next);
    return this;
  }

  toJSON(): ManifestData {
    return this.data;
  }
}
