import { existsSync } from 'node:fs';
import { PalmError } from '../core/errors.js';
import { KINDS, type Kind, type LockEntry, type Lockfile } from '../core/types.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { writeYamlFile } from '../lib/yaml.js';
import { entityId, isViaKind, lockId, Via } from './entity-key.js';
import { loadYaml } from './manifest.js';

interface Keyed {
  kind: Kind;
  name: string;
}

type LockKeyed = Keyed & { origin: string };

/** Resolves lock paths (scope-relative at project scope, absolute at global); `ScopePaths` fits. */
export interface LockPaths {
  abs(lockPath: string): string;
}

/** Reference-counted removal: what goes, and which `via` dependencies stay with a new `via`. */
export interface RemovalPlan {
  /** Entries to undeploy and drop from the lock. */
  removed: LockEntry[];
  /** `via` dependencies that stay because another entry still needs them, with their new `via` (undefined = now direct). */
  kept: Array<{ entry: LockEntry; via?: string }>;
}

export const LOCK_COMMENT = 'palm lockfile — generated, do not edit by hand.';

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

function byKindNameOrigin(a: LockEntry, b: LockEntry): number {
  return (
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.origin.localeCompare(b.origin)
  );
}

function validEntries(file: string, raw: unknown): LockEntry[] {
  const entries = Array.isArray(raw) ? (raw as LockEntry[]) : [];
  for (const [i, e] of entries.entries()) {
    if (!isRecord(e) || [e.kind, e.name, e.origin].some((v) => typeof v !== 'string')) {
      throw new PalmError(
        'E_PARSE',
        `${file}: entry ${i + 1} needs a kind, name and origin`,
        'Restore the lockfile from version control, or delete it and run `palm install`',
      );
    }
    e.targets ??= [];
    e.files ??= [];
  }
  return entries;
}

/** A user-supplied name selects an entry by name, or a registry MCP server by registry name. */
export function answersTo(e: LockEntry, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    e.name.toLowerCase() === lower ||
    (e.kind === 'mcp' && e.origin === 'registry' && e.path.toLowerCase() === lower)
  );
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * palm.lock.yaml as a collection: one entry per kind + name (case-insensitive) + origin, in
 * file order. Lookups by entry, entity and `via` parent are O(1); mutating methods change
 * this lock and return it. `toJSON()` is the plain `Lockfile` data.
 */
export class Lock {
  private readonly byKey = new Map<string, LockEntry>();
  private readonly byEntity = new Map<string, LockEntry[]>();
  /** Built on demand, dropped on every change: `via` children and `deps` users per entity id. */
  private links?: { children: Map<string, LockEntry[]>; users: Map<string, LockEntry[]> };

  /** Entries in order; a repeated kind + name + origin keeps the first. */
  constructor(entries: Iterable<LockEntry> = []) {
    for (const e of entries) if (!this.byKey.has(lockId(e))) this.add(e);
  }

  static from(lock: Lockfile): Lock {
    return new Lock(lock.entries);
  }

  /** Reads palm.lock.yaml; an empty lock when the file is missing. */
  static async load(file: string): Promise<Lock> {
    const data = await loadYaml(file);
    if (data === undefined || data === null) return new Lock();
    if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
    if (data.version !== undefined && data.version !== 1) {
      throw new PalmError(
        'E_PARSE',
        `${file}: unsupported lockfile version ${String(data.version)}`,
        'Upgrade palm.',
      );
    }
    return new Lock(validEntries(file, data.entries));
  }

  /** Writes the lock sorted by kind, name and origin, keys in canonical order, as a fresh document. */
  async save(file: string): Promise<void> {
    const entries = this.entries.sort(byKindNameOrigin).map(orderEntry);
    await writeYamlFile(
      file,
      { version: 1, entries },
      { preserveFrom: false, comment: LOCK_COMMENT },
    );
  }

  /** Every entry, in order (a new array). */
  get entries(): LockEntry[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  toJSON(): Lockfile {
    return { version: 1, entries: this.entries };
  }

  /** The entry for the entity from `origin`, or (no origin) the first from any origin. */
  find(key: Keyed, origin?: string): LockEntry | undefined {
    if (origin !== undefined) return this.byKey.get(lockId({ ...key, origin }));
    return this.byEntity.get(entityId(key))?.[0];
  }

  /** The entity's entries from every origin. */
  findAll(key: Keyed): LockEntry[] {
    return [...(this.byEntity.get(entityId(key)) ?? [])];
  }

  /** Entries a user query names: kind (optional), name or registry name, origin (optional). */
  select(q: { kind?: Kind | undefined; name: string; origin?: string | undefined }): LockEntry[] {
    return this.entries.filter(
      (e) =>
        (!q.kind || e.kind === q.kind) &&
        answersTo(e, q.name) &&
        (!q.origin || e.origin === q.origin),
    );
  }

  /** Inserts the entry, or replaces the one with the same kind + name + origin in place. */
  upsert(entry: LockEntry): this {
    const id = lockId(entry);
    const old = this.byKey.get(id);
    if (!old) return this.add(entry);
    this.byKey.set(id, entry);
    const list = this.byEntity.get(entityId(entry));
    if (list) list[list.indexOf(old)] = entry;
    this.links = undefined;
    return this;
  }

  /** Removes the entry from `origin`, or (no origin) the entity's entries from every origin. */
  remove(key: Keyed & { origin?: string | undefined }): this {
    const gone = key.origin === undefined ? this.findAll(key) : [this.find(key, key.origin)];
    for (const e of gone) if (e) this.drop(e);
    return this;
  }

  private add(e: LockEntry): this {
    this.byKey.set(lockId(e), e);
    push(this.byEntity, entityId(e), e);
    this.links = undefined;
    return this;
  }

  private drop(e: LockEntry): void {
    this.byKey.delete(lockId(e));
    const id = entityId(e);
    const rest = (this.byEntity.get(id) ?? []).filter((x) => x !== e);
    if (rest.length) this.byEntity.set(id, rest);
    else this.byEntity.delete(id);
    this.links = undefined;
  }

  private linked(): NonNullable<Lock['links']> {
    if (this.links) return this.links;
    const children = new Map<string, LockEntry[]>();
    const users = new Map<string, LockEntry[]>();
    for (const e of this.byKey.values()) {
      const via = Via.tryParse(e.via);
      if (via) push(children, via.key.id, e);
      if (isViaKind(e.kind)) for (const d of e.deps ?? []) push(users, entityId(d), e);
    }
    this.links = { children, users };
    return this.links;
  }

  /** Entries installed as dependencies of `parent` (their `via` names it). */
  childrenOf(parent: Keyed): LockEntry[] {
    if (!isViaKind(parent.kind)) return [];
    return [...(this.linked().children.get(entityId(parent)) ?? [])];
  }

  /** The plugin/agent entry this dependency was installed through. */
  parentOf(entry: LockEntry): LockEntry | undefined {
    const via = Via.tryParse(entry.via);
    return via ? this.find(via.key) : undefined;
  }

  /** The top of the entry's `via` chain (the entry itself when installed directly). */
  rootOf(entry: LockEntry): LockEntry {
    const seen = new Set<string>();
    let e = entry;
    for (let p = this.parentOf(e); p && !seen.has(lockId(p)); p = this.parentOf(e)) {
      seen.add(lockId(e));
      e = p;
    }
    return e;
  }

  /** Plugin/agent entries, other than those `leaving` (lock ids), that list `dep` in `deps`. */
  usersOf(dep: Keyed, leaving: ReadonlySet<string> = new Set()): LockEntry[] {
    const users = this.linked().users.get(entityId(dep)) ?? [];
    return users.filter((p) => !leaving.has(lockId(p)));
  }

  /**
   * `parents` and everything installed through them, transitively (breadth first), without
   * descending into entries whose lock id is in `stopAt`.
   */
  dependentsOf(
    parents: readonly LockEntry[],
    stopAt: ReadonlySet<string> = new Set(),
  ): LockEntry[] {
    const seen = new Map<string, LockEntry>();
    const queue = [...parents];
    for (let e = queue.shift(); e; e = queue.shift()) {
      const id = lockId(e);
      if (seen.has(id) || stopAt.has(id)) continue;
      seen.set(id, e);
      queue.push(...this.childrenOf(e));
    }
    return [...seen.values()];
  }

  /**
   * Reference-counted removal (DESIGN §6 "drop `via` deps that no other entry needs").
   * Starting from `roots`, follow `via` links; a dependency stays when `listed` says the
   * manifest names it directly or when an entry that is not being removed lists it in
   * `deps`. With `checkRoots` the roots themselves are subject to the same check.
   */
  planRemoval(
    roots: readonly LockEntry[],
    opts: { listed?: (e: LockEntry) => boolean; checkRoots?: boolean } = {},
  ): RemovalPlan {
    const rootIds = new Set(roots.map(lockId));
    const kept = new Map<string, string | undefined>();
    for (;;) {
      const removed = this.dependentsOf(roots, new Set(kept.keys()));
      const leaving = new Set(removed.map(lockId));
      const before = kept.size;
      for (const c of removed) {
        const id = lockId(c);
        const candidate = rootIds.has(id) ? opts.checkRoots : c.via !== undefined;
        const stay = candidate ? this.stays(c, leaving, opts.listed) : undefined;
        if (stay) kept.set(id, stay.via);
      }
      if (kept.size === before) return { removed, kept: this.keptEntries(kept) };
    }
  }

  /** Why `c` survives the removal of `leaving`: listed directly (no via) or still used by a parent. */
  private stays(
    c: LockEntry,
    leaving: ReadonlySet<string>,
    listed: ((e: LockEntry) => boolean) | undefined,
  ): { via?: string } | undefined {
    if (listed?.(c)) return {};
    const parent = this.usersOf(c, leaving)[0];
    return parent ? { via: Via.of(parent).toString() } : undefined;
  }

  private keptEntries(kept: Map<string, string | undefined>): RemovalPlan['kept'] {
    return this.entries
      .filter((e) => kept.has(lockId(e)))
      .map((entry) => {
        const via = kept.get(lockId(entry));
        return via ? { entry, via } : { entry };
      });
  }

  /** Applies the `via` changes of a removal plan. */
  reparent(kept: RemovalPlan['kept']): this {
    for (const k of kept) {
      const next: LockEntry = { ...k.entry };
      if (k.via) next.via = k.via;
      else delete next.via;
      this.upsert(next);
    }
    return this;
  }

  /** Absolute paths that must survive removing `leaving`: shared merge targets and files of entries that stay. */
  protectedFiles(paths: LockPaths, leaving: Iterable<LockKeyed>): Set<string> {
    const gone = new Set([...leaving].map(lockId));
    const out = new Set<string>();
    for (const e of this.byKey.values()) {
      for (const m of e.merged ?? []) out.add(paths.abs(m.file));
      if (!gone.has(lockId(e))) for (const f of e.files) out.add(paths.abs(f));
    }
    return out;
  }

  /** True when every file the entry lists still exists (a deleted file makes a reinstall redeploy). */
  static filesPresent(entry: LockEntry, paths: LockPaths): boolean {
    return entry.files.every((f) => existsSync(paths.abs(f)));
  }

  /** Every file the entry and whatever it pulled in wrote is still on disk. */
  intact(entry: LockEntry, paths: LockPaths): boolean {
    return this.dependentsOf([entry]).every((e) => Lock.filesPresent(e, paths));
  }
}
