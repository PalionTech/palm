/**
 * palm.lock.yaml v3 as a collection keyed by LockKey (kind + name + source), with the source
 * records, plugin membership, trust and the render hash (DESIGN.md sections 4 and 7).
 */
import { PalmError } from '../core/errors.js';
import type {
  Kind,
  LegacyLockfile,
  LockEntry,
  Lockfile,
  LockSource,
  Rendered,
} from '../core/types.js';
import { sha256 } from '../lib/digest.js';
import { writeFileAtomic } from '../lib/fs.js';
import { canonicalJson } from '../lib/json.js';
import { isRecord } from '../lib/object.js';
import { entityId, lockId, Via } from './entity-key.js';
import { sameName } from './entity-ref.js';
import {
  assertV3,
  compareText,
  legacyLock,
  lockText,
  normalizeLock,
  validEntry,
  validSources,
  versionOf,
} from './lock-format.js';
import { loadYaml } from './yaml-file.js';

export { LOCK_VERSION } from './lock-format.js';
export { fragmentId, fragmentKey } from './merged-record.js';

interface Keyed {
  kind: Kind;
  name: string;
}

/** Turns lock paths into absolute ones and back; `ScopePaths` fits. @public */
export interface LockPaths {
  abs(lockPath: string): string;
  lockForm(abs: string): string;
}

/** What removing some entries takes with it: plugin members go unless another plugin still declares them. */
export interface RemovalPlan {
  /** Entries to undeploy and drop from the lock. */
  removed: LockEntry[];
  /** Members that stay, with their new `via` (undefined: now listed directly). */
  kept: Array<{ entry: LockEntry; via?: string }>;
}

/**
 * The render hash (DESIGN.md section 4): sha256 over the sorted list of (lock path, mode,
 * sha256 of content) of the files a target writes plus (file, at, key, canonical JSON of the
 * value) of the fragments it merges. A function of the render alone, so every machine agrees.
 */
export function renderHashOf(rendered: Pick<Rendered, 'files' | 'fragments'>): string {
  const files = rendered.files.map(
    (f) => `f\0${f.path}\0${f.mode === undefined ? '' : f.mode.toString(8)}\0${sha256(f.data)}`,
  );
  const fragments = rendered.fragments.map(
    (g) => `m\0${g.file}\0${g.at}\0${g.key}\0${canonicalJson(g.value)}`,
  );
  return sha256([...files, ...fragments].sort(compareText).join('\n'));
}

function sameSource(a: string, b: string | undefined): boolean {
  return b === undefined || sameName(a, b);
}

/**
 * palm.lock.yaml: `sources` (url, ref, sha or tree, layout per source name) and one entry per
 * kind + name (case-insensitive) + source. Mutating methods change this lock and return it;
 * `toJSON()` is the plain `Lockfile` in its written (sorted, normalized) form.
 */
export class Lock {
  private readonly byKey = new Map<string, LockEntry>();
  private readonly sourceMap = new Map<string, LockSource>();

  /** A repeated kind + name + source keeps the first entry. */
  constructor(sources: Record<string, LockSource> = {}, entries: Iterable<LockEntry> = []) {
    for (const [name, s] of Object.entries(sources)) this.sourceMap.set(name, s);
    for (const e of entries) if (!this.byKey.has(lockId(e))) this.byKey.set(lockId(e), e);
  }

  static from(lock: Lockfile): Lock {
    return new Lock(lock.sources, lock.entries);
  }

  /**
   * Reads palm.lock.yaml: an empty lock when the file is missing; a 0.1 lock (version 1 or 2)
   * is E_USAGE with the hint `palm migrate`; an entry without kind, name, source, path, content
   * or render is E_PARSE.
   */
  static async load(file: string): Promise<Lock> {
    const data = await loadYaml(file);
    if (data === undefined || data === null) return new Lock();
    if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
    assertV3(file, versionOf(data));
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return new Lock(
      validSources(file, data.sources),
      entries.map((e, i) => validEntry(file, i, e)),
    );
  }

  /** `palm migrate` only: a version 1 or 2 lock as data; undefined when missing or not a 0.1 lock. */
  static async loadLegacy(file: string): Promise<LegacyLockfile | undefined> {
    const data = await loadYaml(file);
    if (!isRecord(data)) return undefined;
    const version = versionOf(data);
    return version === 1 || version === 2 ? legacyLock(data, version) : undefined;
  }

  /** The bytes `save` writes: deterministic, so the same lock always gives the same text. */
  private text(): string {
    return lockText(this.toJSON());
  }

  /** Writes the lock deterministically (DESIGN.md section 4): same lock, same bytes. */
  async save(file: string): Promise<void> {
    await writeFileAtomic(file, this.text());
  }

  /** sha256 of the bytes `save` would write. */
  hash(): string {
    return sha256(this.text());
  }

  get sources(): Record<string, LockSource> {
    return Object.fromEntries(this.sourceMap);
  }

  source(name: string): LockSource | undefined {
    return this.sourceMap.get(name);
  }

  setSource(name: string, s: LockSource): this {
    this.sourceMap.set(name, s);
    return this;
  }

  removeSource(name: string): this {
    this.sourceMap.delete(name);
    return this;
  }

  /** Renames a source and moves its entries to the new name (their files stay until re-rendered). */
  renameSource(from: string, to: string): this {
    const s = this.sourceMap.get(from);
    if (s) {
      this.sourceMap.delete(from);
      this.sourceMap.set(to, s);
    }
    for (const e of this.entriesOf(from)) {
      this.byKey.delete(lockId(e));
      this.upsert({ ...e, source: to });
    }
    return this;
  }

  /** Every entry, in insertion order (a new array). */
  get entries(): LockEntry[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  toJSON(): Lockfile {
    return normalizeLock(this.sources, this.entries);
  }

  /** The entry for the entity from `source`, or (no source) the first from any source. */
  find(key: Keyed, source?: string): LockEntry | undefined {
    if (source !== undefined) return this.byKey.get(lockId({ ...key, source }));
    return this.findAll(key)[0];
  }

  /** The entity's entries from every source. */
  findAll(key: Keyed): LockEntry[] {
    const id = entityId(key);
    return this.entries.filter((e) => entityId(e) === id);
  }

  /** Entries a user query names: kind (optional), name and source (optional), any case. */
  select(q: { kind?: Kind; name: string; source?: string }): LockEntry[] {
    return this.entries.filter(
      (e) =>
        (!q.kind || e.kind === q.kind) &&
        sameName(e.name, q.name) &&
        sameSource(e.source, q.source),
    );
  }

  /** Inserts the entry, or replaces the one with the same kind + name + source in place. */
  upsert(entry: LockEntry): this {
    this.byKey.set(lockId(entry), entry);
    return this;
  }

  /** Removes the entry from `source`, or (no source) the entity's entries from every source. */
  remove(key: Keyed & { source?: string }): this {
    const gone = key.source === undefined ? this.findAll(key) : [this.find(key, key.source)];
    for (const e of gone) if (e) this.byKey.delete(lockId(e));
    return this;
  }

  /** The entries of one source. */
  entriesOf(source: string): LockEntry[] {
    return this.entries.filter((e) => e.source === source);
  }

  /** Members installed through the plugin `parent` (their `via` names it; same source when given). */
  childrenOf(parent: Keyed & { source?: string }): LockEntry[] {
    if (parent.kind !== 'plugin') return [];
    const via = Via.of({ kind: 'plugin', name: parent.name });
    return this.entries.filter((e) => via.is(e.via) && sameSource(e.source, parent.source));
  }

  /** The plugin entry a member was installed through. */
  parentOf(e: LockEntry): LockEntry | undefined {
    const via = Via.tryParse(e.via);
    return via ? this.find(via.key, e.source) : undefined;
  }

  /** Plugin entries, other than those in `leaving` (lock ids), that declare `dep` in `deps`. */
  usersOf(dep: Keyed & { source?: string }, leaving: ReadonlySet<string> = new Set()): LockEntry[] {
    const id = entityId(dep);
    return this.entries.filter(
      (p) =>
        p.kind === 'plugin' &&
        !leaving.has(lockId(p)) &&
        sameSource(p.source, dep.source) &&
        (p.deps ?? []).some((d) => entityId(d) === id),
    );
  }

  /**
   * Removing `roots` (DESIGN.md section 6 "Remove"): a removed plugin takes its members, except
   * a member `listed` says palm.yaml names directly (kept without `via`) and one another plugin
   * that stays still declares (kept, re-parented to that plugin).
   */
  planRemoval(
    roots: readonly LockEntry[],
    opts: { listed?: (e: LockEntry) => boolean } = {},
  ): RemovalPlan {
    const leaving = new Set(roots.map(lockId));
    const removed = [...roots];
    const kept: RemovalPlan['kept'] = [];
    for (const child of roots.flatMap((r) => this.childrenOf(r))) {
      if (leaving.has(lockId(child))) continue;
      const stay = this.stays(child, leaving, opts.listed);
      if (stay) kept.push(stay.via ? { entry: child, via: stay.via } : { entry: child });
      else {
        leaving.add(lockId(child));
        removed.push(child);
      }
    }
    return { removed, kept };
  }

  /** Why `c` survives the removal of `leaving`: listed directly (no via) or still declared by a plugin. */
  private stays(
    c: LockEntry,
    leaving: ReadonlySet<string>,
    listed: ((e: LockEntry) => boolean) | undefined,
  ): { via?: string } | undefined {
    if (listed?.(c)) return {};
    const parent = this.usersOf(c, leaving)[0];
    return parent ? { via: Via.of({ kind: 'plugin', name: parent.name }).toString() } : undefined;
  }

  /** Applies the `via` changes of a removal plan. */
  reparent(kept: RemovalPlan['kept']): this {
    for (const k of kept) {
      const { via: _old, ...rest } = k.entry;
      this.upsert(k.via ? { ...rest, via: k.via } : rest);
    }
    return this;
  }

  /** Every lock-form file of every entry, and every fragment as `file#at#key`. */
  ownedPaths(): Set<string> {
    const out = new Set<string>();
    for (const e of this.byKey.values()) {
      for (const f of e.files) out.add(f);
      for (const m of e.merged ?? []) out.add(`${m.file}#${m.at}#${m.key}`);
    }
    return out;
  }

  /** True when the entry has no executables or a person consented to its exec hash. */
  trusted(entry: LockEntry): boolean {
    return !entry.exec || (entry.trust ?? []).includes(entry.exec.hash);
  }

  /** Records consent to `hash` on the entry (deduplicated). */
  trust(entry: LockEntry, hash: string): this {
    const current = this.find(entry, entry.source) ?? entry;
    const trust = [...new Set([...(current.trust ?? []), hash])].sort(compareText);
    return this.upsert({ ...current, trust });
  }
}
