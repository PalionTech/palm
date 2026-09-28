# palm — internal module API

Signatures every module exports. Modules are written in parallel against this
file; do not rename or change parameter order without updating it. Types come
from `src/core/types.ts`. All local imports use the `.js` suffix (NodeNext).

## src/core (owner: core agent)

```ts
// paths.ts (scope functions are facades over domain/scope-paths.ts; new code uses ScopePaths)
export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv): PalmPaths; // PALM_HOME: `~` expanded, relative → against HOME
export function scopeRoot(paths: PalmPaths, scope: Scope): string;          // projectRoot | home
export function manifestPath(paths: PalmPaths, scope: Scope): string;       // <root>/palm.yaml | <palmHome>/palm.yaml
export function lockPath(paths: PalmPaths, scope: Scope): string;
export function hooksAssetDir(paths: PalmPaths, scope: Scope, entityName: string): string; // <projectRoot>/.palm/hooks/<n> | <palmHome>/hooks/<n>; throws for unsafe names
export function configPath(paths: PalmPaths): string;
export function cacheDir(paths: PalmPaths): string;
// lib/names.ts
export function isSafeName(name: string): boolean;                           // one path segment: [A-Za-z0-9][A-Za-z0-9._-]*, no ".."

// ../domain/scope-paths.ts
export const MANIFEST_FILE = 'palm.yaml', LOCK_FILE = 'palm.lock.yaml';
export function expandHomeDir(value: string | undefined, home: string): string | undefined; // `~`, `~/x`, relative → against home
export function homeOf(env: NodeJS.ProcessEnv): string;                      // HOME | USERPROFILE | os.homedir()
export function palmHomeOf(env: NodeJS.ProcessEnv, home: string): string;   // $PALM_HOME | <home>/.palm
export class ScopePaths {
  constructor(scope: Scope, root: string, palmHome: string, env: NodeJS.ProcessEnv); // root: project root | home
  static of(ctx: { paths: PalmPaths; env: NodeJS.ProcessEnv }, scope: Scope): ScopePaths;
  static from(paths: PalmPaths, scope: Scope, env: NodeJS.ProcessEnv): ScopePaths;
  static at(scope: Scope, root: string, env: NodeJS.ProcessEnv): ScopePaths;  // targets: palm home from env (global: against root)
  readonly scope; root; palmHome; env;
  get manifestFile(): string; get lockFile(): string;
  get palmDir(): string;                        // <root>/.palm | palmHome
  get hooksDir(): string;                       // <palmDir>/hooks
  hooksAssetDir(name: string): string;          // throws E_USAGE for unsafe names
  harnessHome(id: TargetId): string;            // <root>/.<id>; global: CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME override
  harnessOverride(id: 'claude' | 'codex' | 'copilot'): string | undefined;
  abs(lockPath: string): string;                // lock path → absolute
  lockForm(abs: string): string;                // project: posix relative; global: absolute
  boundaries(): string[];                       // project: [root]; global: [home, palmHome, ...harness overrides]
  contains(abs: string): boolean;               // strictly inside a boundary
  safeAbs(lockPath: string): string | undefined; // abs(), undefined when it leaves the scope (tampered lock)
}

// ../domain/merged-record.ts — lockfile `{ file, pointer, value }` (core MergedRecord) ⇄ tagged union; lock format unchanged
export type MergedRecord =
  | { type: 'json-item'; file: string; path: string[]; value: unknown }   // `/hooks/<event>`: item appended to that array
  | { type: 'json-key'; file: string; path: string[]; value: unknown }    // any other JSON pointer: object key (`/mcpServers/<n>`)
  | { type: 'toml-table'; file: string; path: string[]; value: unknown }  // file `*.toml`: `/mcp_servers/<n>`
  | { type: 'md-block'; file: string; id: string; content: string };      // `block:<id>`
export function parseMergedRecord(stored: StoredMergedRecord): MergedRecord; // root / malformed pointer, empty block id → E_INTERNAL
export function toStored(rec: MergedRecord): StoredMergedRecord;
export function pointerOf(rec: MergedRecord): string;                        // also the `file#pointer` key of DeployInput.ownedFiles
export function blockPointer(id: string): string;

// context.ts
export interface ContextInit { cwd: string; env: NodeJS.ProcessEnv; ui: UI; log: Logger; flags: PalmContext['flags'] }
export async function createContext(init: ContextInit): Promise<PalmContext>;
// PalmContext.origins: OriginSet (NEW in wave 2C, types.ts). A lazy accessor: built on first use from
// ctx.config.origins + the project palm.yaml (read ONCE per context; a bad alias there throws on use, not in
// createContext), rebuilt when ctx.config.origins changes (so `ctx.config.origins.push()` in tests still works).
// Assigning it adopts the set's project layer; the user layer always comes from ctx.config. Hand-built contexts
// (test literals) must pass `origins: OriginSet.of()`.
export function refreshOrigins(ctx: PalmContext, change: { config?: PalmConfig; project?: readonly OriginSpec[] | 'reload' }): void;
// the one place ctx.config / the project layer change after a save (addOrigin/removeOrigin/ensureMineOrigin); never mutates the old config

// config.ts — FACADE (`/** facade: prefer src/domain + core/config-file */`): exactly the pre-2C names, now over Origin/OriginSet/config-file
export { loadConfig, saveConfig } from './config-file.js';
export { deriveAlias, type ParseOriginOptions, parseOriginInput, validateOriginUrl } from './origin-input.js';
export function originId(spec: OriginSpec): string;                          // new Origin(spec).id
export function projectOrigins(ctx: PalmContext): OriginSpec[];             // ctx.origins.projectSpecs()
export function allOrigins(ctx: PalmContext): OriginSpec[];                 // ctx.origins.specs(): user order, project-only appended, project wins a clash
export function findOrigin(ctx: PalmContext, alias: string): OriginSpec | undefined;   // ctx.origins.byAlias(alias)?.spec
export function matchOrigin(spec: OriginSpec, query: string): boolean;         // new Origin(spec).matches(query)
export function resolveOriginQuery(ctx: PalmContext, query: string): OriginSpec; // ctx.origins.resolveQuery(query).spec
export async function addOrigin(ctx: PalmContext, spec: OriginSpec, opts?: { scope?: Scope }): Promise<OriginSpec>; // config (global) or palm.yaml origins (project); a taken DERIVED alias is renamed, an explicit one → E_CONFLICT; bad alias → E_USAGE
export async function removeOrigin(ctx: PalmContext, alias: string): Promise<void>; // both files; E_NOT_FOUND when in neither; works with a broken palm.yaml
export async function ensureMineOrigin(ctx: PalmContext): Promise<OriginSpec>; // creates <palmHome>/mine (+ git init) and registers alias "mine"
// (ORIGIN_ALIAS_RE was never exported: use lib/names ALIAS_RE / isValidAlias.)

// config-file.ts — config.yaml and stored origin entries (config.yaml and palm.yaml `origins:`)
export async function loadConfig(paths: PalmPaths): Promise<PalmConfig>;    // { origins: [] } when missing; unknown keys kept; unknown targets dropped; E_IO / E_PARSE; duplicate alias → E_PARSE
export async function saveConfig(paths: PalmPaths, cfg: PalmConfig): Promise<void>; // mode 0600; patches the file (comments, order survive); `targets` flow style
export function normalizeStoredOrigin(raw: unknown, baseDir: string, where: string): OriginSpec; // relative/~ paths against baseDir; url through validateOriginUrl; missing/invalid alias → OriginAliasError (E_PARSE, never skipped)
export function serializeOrigin(spec: OriginSpec): OriginSpec;               // known fields, fixed order, no undefined
export function upsertStoredOrigin(entries: ReadonlyArray<string | OriginSpec>, spec: OriginSpec, baseDir: string, where: string): Array<string | OriginSpec>; // by alias, in place; unparsable entries kept
export function removeStoredOrigin(entries: ReadonlyArray<string | OriginSpec>, alias: string, baseDir: string, where: string): Array<string | OriginSpec>;
export function loadProjectOrigins(paths: PalmPaths, log: Logger): OriginSpec[]; // sync; refused url/path → warn + skip; alias problems and duplicates throw

// origin-input.ts — user input: a table of [test, parse] matchers, first match wins:
//   existing local dir (bare repo → git) | github:/gitlab: prefix | <scheme>:// URL (GitHub tree/blob URLs, GitLab /-/tree/) | scp-like | owner/repo[/sub/dir]
export interface ParseOriginOptions { alias?: string; ref?: string; root?: string; layout?: LayoutDescriptor; cwd?: string }
export function parseOriginInput(input: string, opts?: ParseOriginOptions): OriginSpec; // `#ref` suffix; git URLs pass validateOriginUrl; E_USAGE empty/bad alias, E_ORIGIN otherwise
export function validateOriginUrl(url: string, where?: string): { warning?: string }; // the one gate for git URLs (input + stored origins); throws E_ORIGIN; warns for http:// and git://
export function deriveAlias(spec: OriginSpec, existing: readonly OriginSpec[]): string; // root dir, repo (owner for generic repo names), owner-repo[-root], then -2, -3…; always ALIAS_RE

// ../domain/origin.ts
export const SCP_LIKE: RegExp;                                                // user@host:path
export function trimSlashes(s: string): string; export function stripGit(s: string): string; export function expandTilde(p: string): string;
export function urlParts(url: string): { host: string; segs: string[] };     // git URL, scp address or path (host `file`)
export function sanitizeAlias(s: string): string;
export class OriginAliasError extends PalmError {}                           // stored-alias problems: callers never skip them
export function assertAliasFormat(alias: string, code: 'E_USAGE' | 'E_PARSE', where?: string): void; // hint suggests a valid spelling
export type MatchRank = 0 | 1 | 2 | 3;                                        // 3 alias, 2 exact origin (root included), 1 repo/dir only, 0 none
export interface CheckoutSlot { dir: string; name: string; repoDir: string; metaFile: string; lockFile: string }
export class Origin {
  constructor(spec: OriginSpec); static of(spec: OriginSpec | Origin): Origin;
  readonly spec: OriginSpec; get alias(): string; get isLocal(): boolean; get isGit(): boolean;
  get id(): string;                           // cache dir: <host>__<owner>__<repo>[__<root>] | local__<path>[__<root>]-<hash8>; never the alias
  describe(): string;                         // local path | url[ (root)] (tables, messages)
  repoParts(): { owner?: string; repo: string };
  sameSource(other: Origin): boolean;         // same url (case/.git/trailing slash aside) or resolved path; root/ref/layout ignored
  matchRank(query: string): MatchRank; matches(query: string): boolean; // alias (any case), owner/repo[/root], full url, abs or ~ path
  indexFile(cacheDir: string, ref?: string): string;  // <cacheDir>/<id>[@<ref>][~<layout hash8>].index.json; ref default spec.ref, git only
  checkoutSlot(cacheDir: string): CheckoutSlot;       // <cacheDir>/<id>/{repo | ref-<ref>}, checkout[-ref-<ref>].json, <slot>.lock
}

// ../domain/origin-set.ts — immutable; aliases case-insensitive
export type OriginLayer = 'user' | 'project';
export interface OriginConflict { alias: string; user: Origin; project: Origin }
export class OriginSet {
  static of(user?: Iterable<OriginSpec | Origin>): OriginSet;
  withProject(project: Iterable<OriginSpec | Origin>): OriginSet; // replaces the project layer; project wins an alias clash IN PLACE (today's precedence)
  get size(): number; all(): Origin[]; specs(): OriginSpec[]; userSpecs(): OriginSpec[]; projectSpecs(): OriginSpec[];
  aliases(): string[]; byAlias(alias: string): Origin | undefined;
  resolveQuery(query: string): Origin;        // alias > exact (root included) > repo-only; E_NOT_FOUND (sorted aliases) / E_AMBIGUOUS
  conflicts(): OriginConflict[];              // project aliases shadowing a user alias with another source (for the §2.3 security fix)
  add(spec: OriginSpec, layer?: OriginLayer): OriginSet; // same id → replaced in place; other origin with the alias → E_CONFLICT; bad alias → E_USAGE
  without(alias: string): OriginSet;          // from both layers
}

// manifest.ts, lockfile.ts: facades over the domain classes below (same names and behaviour); new code uses the classes.
export function parseDepRef(spec: string): DepRef;                           // DepRef.parse(spec).toJSON()
export function formatDepRef(ref: DepRef): string;
export function normalizeDep(spec: DepSpec): DepRef;
export async function loadManifest(file: string): Promise<Manifest>;          // {} when missing
export async function saveManifest(file: string, m: Manifest): Promise<void>;
export function addDep(m: Manifest, kind: Kind, dep: DepRef | McpManifestEntry): Manifest;
export function removeDep(m: Manifest, kind: Kind, name: string): Manifest;
export function listDeps(m: Manifest, kind: Kind): Array<DepRef | McpManifestEntry>;
export function isMcpManifestEntry(dep: unknown): dep is McpManifestEntry;  // re-export (domain/manifest)
export async function loadYaml(file: string): Promise<unknown>;             // re-export (domain/manifest): undefined when missing/empty; E_IO / E_PARSE
export async function loadLock(file: string): Promise<Lockfile>;              // {version:1, entries:[]} when missing
export async function saveLock(file: string, lock: Lockfile): Promise<void>;
export function upsertEntry(lock: Lockfile, entry: LockEntry): Lockfile;
export function removeEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): Lockfile;
export function findEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): LockEntry | undefined;

// ../domain/dep-ref.ts — the one dependency grammar `<name>[@<origin>][#<ref>]`; `@` splits only when no `/` follows
export const DEP_GRAMMAR: string;                               // the E_USAGE hint
export function sameName(a: string, b: string): boolean;         // case-insensitive
export class DepRef implements core DepRef {                     // absent origin/ref are not own keys
  readonly name: string; readonly origin?: string; readonly ref?: string;
  static parse(text: string): DepRef;                            // missing name → E_USAGE (hint DEP_GRAMMAR)
  static from(spec: DepSpec): DepRef;                            // string | {name, origin?, ref?} | DepRef; bad object → E_PARSE
  static of(name: string, origin?: string, ref?: string): DepRef; // parts verbatim, no parsing
  withOrigin(origin: string | undefined): DepRef; withRef(ref: string | undefined): DepRef;
  matches(e: { name: string; origin?: string }): boolean;        // names any case; origin only when this names one
  toJSON(): core DepRef; toString(): string;
}

// ../domain/entity-key.ts — identities; `id` is the Map key, names lower-cased
export class EntityKey { static of(e: {kind, name}): EntityKey; readonly kind; name; get id(): string /* kind:name */; is(e: {kind, name}): boolean; toString(): string }
export class LockKey { static of(e: {kind, name, origin}): LockKey; get entity(): EntityKey; get id(): string /* kind:name@origin */; is(e): boolean; toString(): string } // origin exact
export function entityId(e: {kind, name}): string; export function lockId(e: {kind, name, origin}): string;
export type ViaKind = 'plugin' | 'agent'; export function isViaKind(kind: Kind): kind is ViaKind;
export class Via {                                               // LockEntry.via `plugin:<name>` | `agent:<name>`
  static parse(text: string): Via;                               // malformed → E_PARSE
  static tryParse(text: string | undefined): Via | undefined;
  static of(parent: {kind, name}): Via;                          // parent must be plugin/agent (else E_INTERNAL)
  readonly kind: ViaKind; readonly name: string; get key(): EntityKey;
  is(text: string | undefined): boolean;                         // same parent, any case
  toString(): string;
}

// ../domain/manifest.ts — palm.yaml; mutators change the object and return it; toJSON() = core Manifest data
export type ManifestDep = DepRef | McpManifestEntry;
export function depMatches(kind: Kind, dep: core DepRef | McpManifestEntry, e: Pick<LockEntry, 'kind' | 'name' | 'origin' | 'path'>): boolean; // registry MCP also by registry name (= lock path)
export class Manifest {
  static of(data?: core Manifest): Manifest;                     // shallow copy; the input is never changed
  static async load(file: string): Promise<Manifest>;            // {} when missing; non-list section → E_PARSE
  async save(file: string): Promise<void>;                       // patches the file: comments, key order, flow `targets` survive
  get targets(): TargetId[] | undefined; setTargets(t: TargetId[]): this; get origins(): Array<string | OriginSpec> | undefined;
  deps(kind: Kind): ManifestDep[];                               // mcp object entries stay McpManifestEntry
  hasDep(kind: Kind, name: string): boolean;                     // name or registry name, any case
  depFor(e: Installed): ManifestDep | undefined; lists(e: Installed): boolean; // via depMatches
  addDep(kind: Kind, dep: core DepRef | McpManifestEntry | DepSpec): this;    // replaces same name (any case)
  removeDep(kind: Kind, name: string): this;                     // emptied section is dropped
  toJSON(): core Manifest;
}

// ../domain/lock.ts — palm.lock.yaml as a collection keyed by LockKey (O(1) find); mutators change the lock and return it
export interface LockPaths { abs(lockPath: string): string }     // ScopePaths fits
export interface RemovalPlan { removed: LockEntry[]; kept: Array<{ entry: LockEntry; via?: string }> }
export function answersTo(e: LockEntry, name: string): boolean;  // name, or registry name of a registry MCP server
export class Lock {
  constructor(entries?: Iterable<LockEntry>);                    // a repeated kind+name+origin keeps the first
  static from(lock: Lockfile): Lock;
  static async load(file: string): Promise<Lock>;                // empty when missing; bad version / entry without kind,name,origin → E_PARSE
  async save(file: string): Promise<void>;                       // byte-identical to the pre-domain writer: sorted kind/name/origin, fixed key order, header comment
  get entries(): LockEntry[]; get size(): number; toJSON(): Lockfile;
  find(key: {kind, name}, origin?: string): LockEntry | undefined; // no origin: first of any origin
  findAll(key: {kind, name}): LockEntry[];
  select(q: { kind?: Kind; name: string; origin?: string }): LockEntry[]; // user queries (answersTo)
  upsert(entry: LockEntry): this;                                // replaces in place
  remove(key: {kind, name, origin?}): this;                      // no origin: every origin
  childrenOf(parent: {kind, name}): LockEntry[]; parentOf(e: LockEntry): LockEntry | undefined; rootOf(e: LockEntry): LockEntry; // via links, any case; cycles stop
  usersOf(dep: {kind, name}, leaving?: ReadonlySet<string /* lockId */>): LockEntry[]; // plugins/agents listing dep in `deps`
  dependentsOf(parents: readonly LockEntry[], stopAt?: ReadonlySet<string /* lockId */>): LockEntry[]; // parents + via descendants, BFS
  planRemoval(roots: readonly LockEntry[], opts?: { listed?: (e: LockEntry) => boolean; checkRoots?: boolean }): RemovalPlan; // reference counting
  reparent(kept: RemovalPlan['kept']): this;
  protectedFiles(paths: LockPaths, leaving: Iterable<{kind, name, origin}>): Set<string>; // merge targets + files of entries that stay
  static filesPresent(entry: LockEntry, paths: LockPaths): boolean;
  intact(entry: LockEntry, paths: LockPaths): boolean;           // entry and its dependents
}

// git.ts
export async function fetchOrigin(ctx: PalmContext, spec: OriginSpec, opts?: { refresh?: boolean }): Promise<OriginCheckout>;
// git origins live in Origin.checkoutSlot(cacheDir): one slot per requested ref, keyed by url + root + ref (never the
// alias), so two aliases of one repo + root + ref share one checkout. Every fetch runs under
// withCheckoutLock(slot.lockFile) and re-reads the slot once it holds the lock (a concurrent alias/process may have
// fetched it); cache hits and --offline reads take no lock. With `refresh`, a checkout another process/alias
// fetched after this call started is reused instead of fetched again. checkout.json is removed before the work tree
// changes and rewritten atomically after, so a fetch that dies half-way means "re-clone", never a stale sha.
export async function withCheckoutLock<T>(file: string, fn: () => Promise<T>, opts?: { timeoutMs?: number; staleMs?: number }): Promise<T>;
// advisory lock: O_EXCL create of `{pid, host, createdAt}`; mtime refreshed every 60 s while held; waits with backoff
// (25 ms doubling to 1 s) up to timeoutMs (60 s) then E_IO with a hint; a lock untouched for staleMs (10 min) or held
// by a dead pid on this host is taken over; release removes the file only while it is still ours.
export async function listRemoteTags(url: string): Promise<string[]>;
export function latestSemverTag(tags: string[]): string | undefined;
export async function pingRemote(url: string): Promise<void>;                // `palm doctor` reachability, validated + hardened
// every git call: -c protocol.ext.allow=never -c protocol.fd.allow=never -c protocol.file.allow=<user for local origins, else never>, `--` before URLs/refs

// cache.ts
export async function getIndex(ctx: PalmContext, spec: OriginSpec, opts?: { refresh?: boolean; scan?: EngineDeps['scan'] }): Promise<OriginIndex>;
export async function getAllIndexes(ctx: PalmContext, opts?: { refresh?: boolean; scan?: EngineDeps['scan'] }): Promise<OriginIndex[]>;
export async function invalidateIndex(ctx: PalmContext, spec: OriginSpec): Promise<void>;
export function indexFilePath(ctx: PalmContext, spec: OriginSpec): string;   // Origin.indexFile(<cache>): <originId>[@<ref>][~<layout hash>].index.json (atomic writes)
// getAllIndexes iterates ctx.origins.all(); indexes are written with lib/fs writeJsonFile (temp + rename).

// hash.ts
export async function hashPath(absPath: string, opts?: { boundary?: string }): Promise<string>; // "sha256:<hex>", dir = sorted (relpath + NUL + content + NUL)
// The directory walk is the copy walk (lib/fs walkFiles): HASH_SKIP (= COPY_SKIP: .git, node_modules, .DS_Store, *.zip)
// left out; a symlink is followed and its target hashed only when its real path stays inside `boundary`
// (default absPath; the engine passes the origin root, as deploySkill does); a root leaving it → E_IO.
// Text content (no NUL in the first 8 KB) is hashed with CRLF → LF, so core.autocrlf checkouts match LF ones.
// Hash changes in wave 2D: LF content without skipped entries or symlinks hashes exactly as before (checked
// against recorded fixture hashes in test/core/hash.test.ts); CRLF text, dirs holding node_modules/.DS_Store/*.zip,
// and in-origin symlinked content now hash differently, so such entries show as updated once on the next install.
```

## src/engine (owner: core agent)

```ts
// EngineDeps (src/core/types.ts) spells out each collaborator's signature: scan, getTarget, resolveRegistry,
// resolveSecrets (the former ScanOriginFn/ResolveRegistryFn/ResolveSecretsFn aliases are gone; use EngineDeps['scan'] …).
// src/engine/deps.ts re-exports EngineDeps and supplies the lazily imported defaults:
export function defaultEngineDeps(): EngineDeps;
export async function resolveEngineDeps(partial?: Partial<EngineDeps>, opts?: { targets?: boolean }): Promise<EngineDeps>;

// install.ts
export async function installEntities(ctx: PalmContext, requests: InstallRequest[], opts: InstallOptions, deps?: Partial<EngineDeps>): Promise<InstallResult>;
export function dedupeOutcomes(outcomes: InstallOutcome[]): InstallOutcome[];   // one per kind+name+origin
export async function preflightInstall(ctx: PalmContext, requests: InstallRequest[], deps?: Partial<EngineDeps>): Promise<void>; // CLI runs it before resolveTargets: throws installEntities' E_NOT_FOUND/E_ORIGIN for unmatched names; skips ad hoc/registry-only names; no picker
// uninstall.ts
export async function uninstallEntities(ctx: PalmContext, refs: Array<{ kind?: Kind; name: string; origin?: string }>, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<{ removed: LockEntry[]; warnings: string[] }>;
export function planRemoval(lock: Lockfile, roots: LockEntry[], opts?: { manifest?: Manifest; checkRoots?: boolean }): { removed: LockEntry[]; kept: Array<{ entry: LockEntry; via?: string }> }; // Lock.planRemoval over plain data
export function reparent(lock: Lockfile, kept: Array<{ entry: LockEntry; via?: string }>): Lockfile;             // Lock.reparent over plain data
export function collectDependents(lock: Lockfile, parents: LockEntry[], kept?: Set<string>): LockEntry[];       // Lock.dependentsOf; `kept` holds lockId()s
// The engine itself works on Lock / Manifest / ScopePaths (load once, mutate, save when JSON.stringify changed).
// installEntities classifies each InstallRequest once into an internal tagged union
// `{ mode: 'adhoc' | 'registry' | 'index' }`; the public InstallRequest shape is unchanged.
// sync.ts
export async function syncManifest(ctx: PalmContext, opts: { scope: Scope; prune: boolean; targets?: TargetId[]; secretPolicy?: SecretPolicy }, deps?: Partial<EngineDeps>): Promise<InstallResult & { extraneous: LockEntry[] }>;
export function satisfies(e: LockEntry, d: { kind: Kind; dep: DepRef | McpManifestEntry }): boolean; // domain depMatches; registry MCP: lock path = registry name (used by doctor)
export function manifestDeps(m: Manifest | domain Manifest): Array<{ kind: Kind; dep: DepRef | McpManifestEntry }>; // used by doctor
// update.ts
export async function updateEntities(ctx: PalmContext, refs: Array<{ kind?: Kind; name: string }>, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<InstallResult>; // a dependency refreshes through the root of its via chain (Lock.rootOf)
// resolve-targets.ts
export async function resolveTargets(ctx: PalmContext, opts: { scope: Scope; flag?: TargetId[]; save?: boolean }, deps?: Partial<EngineDeps>): Promise<TargetId[]>; // save: persist an explicit flag or a pick when it differs
// query.ts
export async function listInstalled(ctx: PalmContext, scope: Scope, kind?: Kind): Promise<LockEntry[]>;
export async function findCandidates(ctx: PalmContext, kind: Kind | undefined, name: string, opts: { origin?: string; from?: OriginSpec; refresh?: boolean }, deps?: Partial<EngineDeps>): Promise<Entity[]>;
export async function searchIndex(ctx: PalmContext, query: string, opts: { kind?: Kind; origin?: string; refresh?: boolean }, deps?: Partial<EngineDeps>): Promise<Array<{ entity: Entity; score: number }>>;
export async function getEntityInfo(ctx: PalmContext, kind: Kind, name: string, opts: { origin?: string; scope: Scope }, deps?: Partial<EngineDeps>): Promise<{ entity?: Entity; lock?: LockEntry; deps: EntityRef[]; warnings: string[] }>; // warnings: duplicate-name notes for this entity
export function duplicateWarnings(index: Pick<OriginIndex, 'warnings'>, kind?: Kind, name?: string): string[];
export function entityDeps(entity: Entity): EntityRef[];                       // plugin members; agent skills, mcpServers, instructions
export function agentDepSpecs(entity: Entity): Array<{ kind: Kind; dep: DepRef }>; // dep is a domain DepRef (DepRef.parse)
```

## src/index (owner: scanner agent)

```ts
// scan.ts
export async function scanOrigin(root: string, spec: OriginSpec): Promise<ScanResult>;
// marketplace.ts
export const parseMarketplace: (file: string, base: { url?: string; path?: string; ref?: string }) => Promise<{ origins: OriginSpec[]; warnings: string[] }>; // expand marketplace.json → OriginSpec[]
// ignore.ts: fast-glob patterns built from the domain/ignore lists
export function defaultIgnoreGlobs(extra?: string[]): string[];
export function minimalIgnoreGlobs(extra?: string[]): string[];
export function findMarketplaceFile(root: string): Promise<string | undefined>;
// frontmatter.ts
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string };
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string;
// agents.ts / instructions.ts / commands.ts / hooks.ts / mcp.ts / skills.ts
export function parseAgentFile(absPath: string, text: string): AgentDefinition;        // claude-md | copilot .agent.md | codex .toml
export function parseInstructionFile(absPath: string, text: string): InstructionDefinition;
export function parseCommandFile(absPath: string, text: string): CommandDefinition;
export function parseHooksJson(name: string, json: unknown, pluginRootRel?: string): HookSet;
export function parseMcpJson(json: unknown): McpServerConfig[];                        // wrapped or flat
export function parseSkillMd(dirName: string, text: string): SkillDefinition;
```

## src/targets (owner: targets agent)

```ts
// index.ts
export function getTarget(id: TargetId): Target;
export function allTargets(): Target[];
// convert-agent.ts
export function renderAgent(def: AgentDefinition, target: TargetId): { fileName: string; content: string; dropped: string[] };
// convert-instruction.ts
export function renderInstruction(def: InstructionDefinition, target: TargetId): { fileName: string; content: string } | { managedBlock: string };
// convert-command.ts
export function renderCommand(def: CommandDefinition, target: TargetId): { fileName: string; content: string };
// convert-hooks.ts
export function convertHooks(hooks: HookSet, target: TargetId, pluginRootAbs: string, paths: ScopePaths): { hooks: unknown; dropped: string[] }; // plugin-root commands also export CLAUDE_PLUGIN_ROOT / CURSOR_PLUGIN_ROOT; claude project: $CLAUDE_PROJECT_DIR/<paths.lockForm(pluginRootAbs)>
// fs-utils.ts
export async function listCopyFiles(root: string, opts?: { skipTop?: readonly string[]; boundary?: string }): Promise<WalkResult>; // lib/fs walkFiles with COPY_SKIP + top-level skipTop; symlinks only inside `boundary`
// recorded.ts
export function redactSecrets<T>(value: T, secrets: Record<string, string> | undefined): T;  // literal values → ${NAME} for MergedRecord.value
export function containsAll(actual: unknown, recorded: unknown): boolean;                   // ${VAR} in recorded strings matches any text
// Target.undeploy(entry, scope, scopeRoot, dryRun, env?) — env as DeployInput.env
// mcp-config.ts
export function renderMcpEntry(cfg: McpServerConfig, target: TargetId, policy: SecretPolicy, values?: Record<string, string>): unknown; // harness-specific object/table
// Records below are the domain/merged-record.ts union with an absolute `file`; base.ts stores them with toStored().
// json-merge.ts
export async function appendJsonItem(file: string, arrayPath: readonly string[], item: unknown, opts: JsonMergeOptions): Promise<JsonItemRecord>; // no-op when a deep-equal item exists
export async function setJsonKey(file: string, keyPath: readonly string[], value: unknown, opts: JsonMergeOptions): Promise<JsonKeyRecord>;    // onConflict: 'error' → E_CONFLICT
export async function ensureJsonKey(file: string, keyPath: readonly string[], value: unknown, opts: { dryRun: boolean }): Promise<boolean>;     // not recorded
export async function unmergeJsonFile(file: string, record: JsonItemRecord | JsonKeyRecord): Promise<void>;
// toml-merge.ts (codex)
export async function mergeTomlTable(file: string, tablePath: string[], value: Record<string, unknown>, opts: TomlMergeOptions): Promise<TomlTableRecord>;
export async function unmergeTomlTable(file: string, record: TomlTableRecord): Promise<void>;
// managed-block.ts (AGENTS.md sections)
export async function upsertManagedBlock(file: string, id: string, content: string, opts: ManagedBlockOptions): Promise<MdBlockRecord>;
export async function removeManagedBlock(file: string, id: string): Promise<void>;
// base.ts — TargetSpec { id; displayName; layout(paths: ScopePaths): TargetLayout; detect(paths: ScopePaths): Promise<boolean> }
// A deploy fills a DeployPlan (writes, files, merged, notes) that a Writer applies (collision policy, rollback).
// Target env: DeployInput.env / undeploy env → env bound by createTarget(id, env) → process.env.
export function createTarget(id: TargetId, env?: NodeJS.ProcessEnv): GenericTarget;
```

## src/domain: secrets and skip lists (wave 2D)

```ts
// secrets.ts: the one implementation of "which ${VAR} placeholders of an MCP config are user secrets"
// (used by src/index/mcp, src/targets/mcp-config, src/engine/install and src/mcp/secrets)
export function detectSecrets(cfg: McpServerConfig): SecretRef[];      // env, headers, url, args; runtime vars skipped; one ref per name, required ORed, header use wins; `Bearer ${T}` → format "Bearer {value}"
export function allSecrets(cfg: McpServerConfig): SecretRef[];         // cfg.secrets ∪ detected, by name; declared entries win (required, header, description)
export function optionalSecretNames(cfg: McpServerConfig): Set<string>;
export function requiredSecretNames(cfg: McpServerConfig): Set<string>;
// ignore.ts: the one home for skip lists (entries are names; `*.ext` = suffix, any case)
export const ALWAYS_SKIP_DIRS: readonly string[];      // .git, node_modules (scan, copy, hash)
export const SCAN_IGNORE_DIRS: readonly string[];      // ALWAYS_SKIP_DIRS + test(s), fixture(s), eval(s), example(s), template(s), docs, website, dist, build
export const INSTALL_OUTPUT_DIRS: readonly string[];   // .claude/skills, .github/agents, .vscode, … (scan)
export const ROOT_IGNORED_FILES: readonly string[];    // AGENTS.md, CLAUDE.md, … at the origin root (scan)
export const DOC_FILE_NAMES: readonly string[];        // readme.md, changelog.md, … never entities (scan)
export const COPY_SKIP: readonly string[];             // .git, node_modules, .DS_Store, *.zip (copy)
export const HASH_SKIP: readonly string[];             // === COPY_SKIP (hash what is deployed)
export const HOOK_ASSET_SKIP_TOP: readonly string[];   // plugin-root docs/tests/CI dirs not copied with hook scripts
export const HOOK_ASSET_SKIP_FILE: RegExp;             // README|CHANGELOG|… at the plugin root
export function matchesSkip(list: readonly string[], name: string): boolean;
export function shouldSkipDir(name: string): boolean;  // scan: SCAN_IGNORE_DIRS
export function shouldSkipFile(name: string): boolean; // copy/hash: COPY_SKIP, decided on the name before the entry is examined
export function isDocFile(fileName: string): boolean;
export function isScanIgnoredRel(rel: string): boolean; // an ignored segment, or under an install output
```

## src/mcp (owner: mcp agent)

```ts
// registry.ts
export async function searchRegistry(query: string, opts?: SearchRegistryOptions): Promise<RegistryCandidate[]>;   // opts: registryUrl, limit, fetchImpl, timeoutMs
export async function resolveRegistry(name: string, opts?: ResolveRegistryOptions): Promise<RegistryCandidate[]>;   // opts: registryUrl, version, fetchImpl, timeoutMs
export const DEFAULT_REGISTRY_URL: string;
// serverjson.ts
export function serverJsonToConfig(serverJson: unknown): McpServerConfig;
// secrets.ts
export async function resolveSecrets(ctx: PalmContext, cfg: McpServerConfig, policy: SecretPolicy): Promise<{ values: Record<string, string>; envRefs: string[] }>; // over allSecrets(cfg): env lookup, masked prompts
export { detectSecrets } from '../domain/secrets.js';                 // re-export; the rules live in src/domain/secrets.ts
// RUNTIME_VARS / isRuntimeVar / isFillInValue (was isPlaceholderValue) live in src/lib/placeholders.ts;
// allSecrets / optionalSecretNames / requiredSecretNames in src/domain/secrets.ts.
// adhoc.ts
export function parseAdhocMcp(name: string, opts: { command?: string[]; url?: string; headers?: string[]; env?: string[]; transport?: string }): McpServerConfig;
```

## src/cli.ts, src/commands/*, src/ui/*, src/create/* (owner: cli agent)

`src/cli.ts` only calls `runCli` and exits. The command tree is registration only: every action
builds an `Invocation` and hands it to a dispatcher that imports the command module lazily (one
dynamic import per command), so `palm --help` loads commander and picocolors only.

```ts
// commands/main.ts
export const EXIT: { ok: 0; failure: 1; usage: 2; internal: 70; cancelled: 130 };
export function exitCodeFor(e: unknown): number;               // CommanderError → 2 (0 for help/version), ExitSignal → its code, E_USAGE → 2, E_CANCELLED → 130, other PalmError → 1, anything else → 70
export async function runCli(argv: string[], opts?: CliOptions): Promise<number>; // CliOptions: version, stdout/stderr sinks, ui, cwd, env, deps (engine fakes), dispatch (grammar tests)
// commands/grammar.ts (pure; loaded by --help)
export type Verb = 'install' | 'uninstall' | 'get' | 'describe' | 'update' | 'create' | 'search';
export const VERBS: readonly VerbSpec[];                       // name, aliases, summary, resources it accepts, kindRequired
export interface Invocation { command: string; resource?: Resource; names: string[]; opts: Record<string, unknown>; marketplace?: boolean }
export type Dispatch = (inv: Invocation) => Promise<void>;
export function interpretWords(verb: Verb, words: string[]): { resource?: Resource; names: string[] }; // first word → resource (singular, plural, short name), rest → names; E_USAGE for resources a verb does not take
export function splitPassthrough(argv: string[]): { args: string[]; passthrough: string[] };
export class ExitSignal extends Error { exitCode: number }     // end with a code after the command printed its own output
// commands/program.ts
export function buildProgram(opts: { version?: string; dispatch: Dispatch; writeOut?; writeErr? }): Command; // verbs, utilities, hidden old forms (`origin add|list|remove|update|import`, `targets`)
export function parseArgv(argv: string[]): { invocation: Invocation; passthrough: string[] }; // parse exactly as the CLI would, run nothing
// commands/<verb>.ts: export async function run(inv: Invocation, app: App): Promise<void>
// commands/app.ts
export interface App { out: Output; passthrough: string[]; program?: Command; ui?: UI; cwd?: string; env?: NodeJS.ProcessEnv; deps?: Partial<EngineDeps> }

// ui/output.ts: the one output writer (ctx.log is this object during a command)
export interface Output extends Logger {
  jsonMode: boolean; verbose: boolean;
  configure(opts: { json?: boolean; verbose?: boolean }): void;
  out(line?: string): void;                                   // data: stdout, or stderr under --json
  table(rows: string[][], header?: string[]): void;
  json(value: unknown): void;                                 // buffered; finish() writes { ...value | items: value, warnings }
  mark(mark: Mark, msg: string): void;                        // + added, - removed, ~ updated, = unchanged, x error, ! warning, i info
  added(msg): void; removed(msg): void; updated(msg): void; unchanged(msg): void;
  error(msg: string, hint?: string): void;                    // stderr
  hint(msg: string): void;                                    // dim follow-up line
  warn(msg: string): void;                                    // collected, printed once by finish() under "Warnings"
  warnings(): string[];
  finish(): void;
}
export function createOutput(opts?: { json?: boolean; verbose?: boolean; stdout?: Sink; stderr?: Sink }): Output;
export function outputOf(log: Logger): Output;               // ctx.log as a writer (plain Loggers are adapted)
export function jsonEnvelope(value: unknown, warnings: string[]): Record<string, unknown>;
export function failureCount(result: object): number;       // `failures` array or outcomes with status "failed"; non-zero → exit 1
export function printInstallSummary(out: Output, result: InstallResult, opts: { scope: Scope; targets: TargetId[] }): void;
export function formatTable(rows: string[][], header?: string[]): string;
// ui/prompts.ts
export function createClackUI(opts?: { output?: Writable }): MultilineUI; // Esc / Ctrl-C → PalmError('E_CANCELLED', 'cancelled')
export function createNonInteractiveUI(): UI;             // every prompt throws PalmError('E_NON_INTERACTIVE', ...)
// create/agent.ts etc.
export async function createAgent(ctx: PalmContext, opts: CreateOptions): Promise<void>; // CreateOptions: name?, install?, scope, targets?
export async function createSkill(ctx: PalmContext, opts: CreateOptions): Promise<void>;
export async function createInstruction(ctx: PalmContext, opts: CreateOptions): Promise<void>;
export async function createCommand(ctx: PalmContext, opts: CreateOptions): Promise<void>;
// core/kinds.ts (cli agent)
export type Resource = Kind | 'origin' | 'target' | 'all';
export function parseResource(word: string | undefined): Resource | undefined; // singular, plural, short (sk ag ins cmd hk mcp pl orig tg), all
export function parseKind(word: string | undefined): Kind | undefined;         // entity kinds only
export function resourceWords(resource: Resource): string[];                    // every word for a resource (completion)
```

## Ownership map

| Directory | Owner |
|---|---|
| `src/core/**` (except types/kinds/errors), `src/engine/**`, `test/core`, `test/engine` | core agent |
| `src/index/**`, `test/index`, `test/fixtures/**` | scanner agent |
| `src/targets/**`, `test/targets` | targets agent |
| `src/mcp/**`, `test/mcp` | mcp agent |
| `src/cli.ts`, `src/commands/**`, `src/ui/**`, `src/create/**`, `test/cli` | cli agent |

Contract changes go into `src/core/types.ts`, `DESIGN.md` and this file together (the
integration pass lifted the former local stand-ins `DeployInputWithEnv`, `UndeployWithEnv`,
`TargetDeployInput` and `EngineInstallRequest` into `DeployInput.env`, the `env` argument of
`Target.undeploy`, and `InstallRequest.registry`).
