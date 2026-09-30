/**
 * palm.yaml v3 (DESIGN.md section 3): targets, sources with their entries, and hand-declared
 * MCP servers. Mutators change the object and return it; `save` patches the file so comments,
 * key order and unknown keys survive.
 */
import { manifestKey } from '../core/kinds.js';
import type {
  EntityRef,
  Kind,
  Manifest as ManifestData,
  ManifestEntry,
  ManifestEntryObject,
  ManifestSource,
  McpManifestEntry,
  Source,
  TargetId,
} from '../core/types.js';
import { KINDS } from '../core/types.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { writeYamlFile, type YamlPath } from '../lib/yaml.js';
import { parseEntityRef, sameName } from './entity-ref.js';
import { checkedManifest, ENTRY_KEYS } from './manifest-check.js';
import { SourceSet, toManifestSource } from './source.js';
import { loadYaml } from './yaml-file.js';

export { detectManifestFormat } from './manifest-check.js';

type Body = ManifestSource & Record<string, unknown>;

/** A manifest entry as an object (a string is its name). */
function toObject(entry: ManifestEntry): ManifestEntryObject {
  return typeof entry === 'string' ? { name: entry } : entry;
}

/** The written form of an entry: the bare name when it has no options. */
function toItem(entry: ManifestEntry): ManifestEntry {
  if (typeof entry === 'string') return entry;
  const clean = withoutUndefined(entry);
  return Object.keys(clean).length === 1 ? clean.name : clean;
}

function entryName(entry: ManifestEntry): string {
  return typeof entry === 'string' ? entry : entry.name;
}

/** The collections palm writes in flow style when it creates them (targets, entry objects, small maps). */
function isFlow(p: YamlPath): boolean {
  const [top, , key, index] = p;
  if (top === 'targets') return p.length === 1;
  if (top === 'sources')
    return (p.length === 4 && typeof index === 'number') || (p.length === 3 && key === 'layout');
  return (
    top === 'mcp' && p.length === 3 && ['args', 'env', 'headers', 'targets'].includes(String(key))
  );
}

/** True when a source body lists at least one entry. */
function hasEntries(body: Body | undefined): boolean {
  return (
    !!body && ENTRY_KEYS.some((k) => Array.isArray(body[k]) && (body[k] as unknown[]).length > 0)
  );
}

/** `body` without empty entry lists. */
function withoutEmptyLists(body: Body): Body {
  const out: Body = { ...body };
  for (const k of ENTRY_KEYS)
    if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k];
  return out;
}

/** Only/exclude say whether a plugin member is selected (`kind:name`, names in any case). */
export function memberSelected(entry: ManifestEntryObject, member: EntityRef): boolean {
  const names = (list: string[] | undefined) =>
    (list ?? []).some((text) => {
      const ref = parseEntityRef(text);
      return sameName(ref.name, member.name) && (!ref.kind || ref.kind === member.kind);
    });
  if (entry.only?.length && !names(entry.only)) return false;
  return !names(entry.exclude);
}

export class Manifest {
  private data: ManifestData & Record<string, unknown>;

  private constructor(data: ManifestData) {
    this.data = data as ManifestData & Record<string, unknown>;
  }

  /** Wraps plain manifest data (the input object is never changed). */
  static of(data: ManifestData = {}): Manifest {
    return new Manifest(structuredClone(data));
  }

  /**
   * Reads palm.yaml: empty when missing; the 0.1 format is E_USAGE (hint `palm migrate`); a
   * malformed key is E_PARSE naming it. Unknown keys are kept.
   */
  static async load(file: string): Promise<Manifest> {
    return new Manifest(checkedManifest(file, await loadYaml(file)));
  }

  /**
   * Writes palm.yaml by patching the file, so comments, key order and a flow `targets:` survive.
   * Empty entry lists, sources without entries and empty `sources:`/`mcp:` sections are dropped.
   */
  async save(file: string): Promise<void> {
    await writeYamlFile(file, this.written(), { flow: isFlow });
  }

  /** The document `save` writes. */
  private written(): Record<string, unknown> {
    const sources = Object.entries(this.data.sources ?? {})
      .filter(([, body]) => hasEntries(body as Body))
      .map(([name, body]) => [name, withoutEmptyLists(body as Body)] as const);
    return withoutUndefined({
      ...this.data,
      sources: sources.length ? Object.fromEntries(sources) : undefined,
      mcp: Object.keys(this.data.mcp ?? {}).length ? this.data.mcp : undefined,
    });
  }

  get targets(): TargetId[] | undefined {
    return this.data.targets;
  }

  setTargets(targets: TargetId[]): this {
    this.data = { ...this.data, targets: [...targets] };
    return this;
  }

  /** The declared sources, local paths resolved against `baseDir`; `where` names the file in errors. */
  sources(baseDir: string, where: string): SourceSet {
    return SourceSet.fromManifest(this, baseDir, where);
  }

  sourceNames(): string[] {
    return Object.keys(this.data.sources ?? {});
  }

  /** The key of the source named `name` (any case), if declared. */
  private keyOf(name: string): string | undefined {
    return this.sourceNames().find((k) => sameName(k, name));
  }

  hasSource(name: string): boolean {
    return this.keyOf(name) !== undefined;
  }

  private body(name: string): Body | undefined {
    const key = this.keyOf(name);
    return key === undefined ? undefined : ((this.data.sources?.[key] ?? {}) as Body);
  }

  private setBody(name: string, body: Body | undefined): void {
    const key = this.keyOf(name) ?? name;
    const sources: Record<string, ManifestSource> = { ...(this.data.sources ?? {}) };
    if (body) sources[key] = body;
    else delete sources[key];
    this.data = { ...this.data, sources };
  }

  /**
   * Declares `source` (by name), or updates its location, ref, alias and layout; its entries and
   * unknown keys stay. `baseDir` makes a local path relative.
   */
  addSource(source: Source, baseDir: string): this {
    const old = this.body(source.name) ?? {};
    const location = toManifestSource(source, baseDir);
    const rest = Object.fromEntries(
      Object.entries(old).filter(
        ([k]) => !['url', 'path', 'root', 'ref', 'alias', 'layout'].includes(k),
      ),
    );
    this.setBody(source.name, { ...location, ...rest });
    return this;
  }

  removeSource(name: string): this {
    this.setBody(name, undefined);
    return this;
  }

  /** The entries of one source and kind, as objects (strings become `{ name }`). */
  entries(name: string, kind: Kind): ManifestEntryObject[] {
    const list = this.body(name)?.[manifestKey(kind)];
    return Array.isArray(list) ? list.map(toObject) : [];
  }

  /** Every entry of every source, in file order. */
  allEntries(): Array<{ source: string; kind: Kind; entry: ManifestEntryObject }> {
    return this.sourceNames().flatMap((source) =>
      KINDS.flatMap((kind) => this.entries(source, kind).map((entry) => ({ source, kind, entry }))),
    );
  }

  /** True when the source lists `entity` under `kind` (names in any case). */
  hasEntry(name: string, kind: Kind, entity: string): boolean {
    return this.entries(name, kind).some((e) => sameName(e.name, entity));
  }

  private setList(name: string, kind: Kind, list: ManifestEntry[]): void {
    const body: Body = { ...(this.body(name) ?? {}) };
    if (list.length) body[manifestKey(kind)] = list;
    else delete body[manifestKey(kind)];
    this.setBody(name, body);
  }

  private list(name: string, kind: Kind): ManifestEntry[] {
    const list = this.body(name)?.[manifestKey(kind)];
    return Array.isArray(list) ? [...list] : [];
  }

  /** Adds the entry, or replaces the one with the same name; one without options is written as its name. */
  addEntry(name: string, kind: Kind, entry: ManifestEntry): this {
    const list = this.list(name, kind);
    const at = list.findIndex((e) => sameName(entryName(e), entryName(entry)));
    if (at >= 0) list[at] = toItem(entry);
    else list.push(toItem(entry));
    this.setList(name, kind, list);
    return this;
  }

  /** Removes the entry; an emptied list goes, and so does a source left without entries. */
  removeEntry(name: string, kind: Kind, entity: string): this {
    if (!this.hasSource(name)) return this;
    this.setList(
      name,
      kind,
      this.list(name, kind).filter((e) => !sameName(entryName(e), entity)),
    );
    if (!hasEntries(this.body(name))) this.removeSource(name);
    return this;
  }

  /** Adds `kind:name` to the `exclude:` of the plugin entry `plugin` (no duplicates). */
  excludeMember(name: string, plugin: string, member: EntityRef): this {
    const entry = this.entries(name, 'plugin').find((e) => sameName(e.name, plugin));
    if (!entry) return this;
    const text = `${member.kind}:${member.name}`;
    const exclude = entry.exclude ?? [];
    if (!exclude.some((x) => sameName(x, text)))
      this.addEntry(name, 'plugin', { ...entry, exclude: [...exclude, text] });
    return this;
  }

  /** Hand-declared MCP servers, by config name. */
  get mcp(): Record<string, McpManifestEntry> {
    return { ...(this.data.mcp ?? {}) };
  }

  setMcp(name: string, e: McpManifestEntry): this {
    this.data = { ...this.data, mcp: { ...(this.data.mcp ?? {}), [name]: withoutUndefined(e) } };
    return this;
  }

  removeMcp(name: string): this {
    const mcp = { ...(this.data.mcp ?? {}) };
    delete mcp[name];
    this.data = { ...this.data, mcp };
    return this;
  }

  /** The plain data (for `JSON.stringify` change detection). */
  toJSON(): ManifestData {
    const out = { ...this.data };
    if (!isRecord(out.sources) || Object.keys(out.sources).length === 0) delete out.sources;
    if (!isRecord(out.mcp) || Object.keys(out.mcp).length === 0) delete out.mcp;
    return out;
  }
}
