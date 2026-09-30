# palm internal module API (v3, palm 0.2)

Signatures every module exports. Modules are written in parallel against this file; do not
rename or change parameter order without updating it, `DESIGN.md` and `src/core/types.ts`
together. Types come from `src/core/types.ts`. All local imports use the `.js` suffix
(NodeNext). "Lock form" means a project-relative posix path (project scope) or a token path
(`<claude>/skills/x`, global scope); "absolute" means an absolute filesystem path.

Each section names its owner (the ownership map is at the end). A module may consume another
area's exports only as written here; what it needs beyond that is a contract change.

## src/lib (owner: domain agent)

palm-free primitives. Unchanged from 0.1 unless listed.

```ts
// fs.ts
export async function writeFileAtomic(abs: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>; // temp + rename next to the link's final target
export async function pathExists(abs: string): Promise<boolean>;
export async function isSameFile(a: string, b: string): Promise<boolean>;
export async function walkFiles(root: string, opts?: WalkOptions): Promise<WalkResult>;
//   WalkOptions { skip?: (name: string, rel: string) => boolean /* decided on the name before the entry is examined */; boundary?: string /* default root */ }
//   WalkResult { files: Array<{ rel; abs; mode; size }>; skipped: string[] /* links leaving the boundary, broken links, unreadable entries */; symlinksOutside: string[] /* the part of skipped that leaves the boundary; '.' for the root */ }
export async function removeEmptyParents(abs: string, stopAt: string): Promise<string[]>;    // the directories removed
export async function realpathInside(abs: string, roots: readonly string[]): Promise<{ real: string; inside: boolean; dangling: boolean }>; // NEW: realpath of the deepest existing ancestor + the rest; inside = under one of roots
export async function isGitIgnored(abs: string, cwd: string): Promise<boolean | undefined>;   // NEW: `git check-ignore -q`, undefined when git or a repository is missing
export async function isGitTracked(abs: string, cwd: string): Promise<boolean | undefined>;   // NEW: `git ls-files --error-unmatch`
export async function gitToplevel(dir: string): Promise<string | undefined>;                   // NEW: `git rev-parse --show-toplevel`, undefined outside a repository
export async function gitDiffStat(dir: string): Promise<string | undefined>;                   // NEW: `git diff --stat -- .` below dir (printed after `palm update`), undefined outside a repository or when clean
// (the three git helpers live in lib/git-query.ts, re-exported by fs.ts; they call core/git-exec runGit through an injected runner
//  to keep lib palm-free: `setGitRunner(next: GitRunner | undefined)`, installed by core/context createContext)
// json.ts, yaml.ts, frontmatter.ts, names.ts, object.ts, placeholders.ts, text.ts, unicode.ts: as in 0.1
export function sha256(data: string | Uint8Array): string; export function short(hash: string, n?: number): string; // digest.ts; core/hash.ts re-exports both
export function canonicalJson(value: unknown): string;                                        // NEW (json.ts): keys sorted by code point, undefined-valued keys dropped, no whitespace, for hashes
export function entropyBitsPerChar(s: string): number;                                        // NEW (text.ts): Shannon entropy
export const ALIAS_RE: RegExp;                                                                // names.ts: ^[a-z0-9][a-z0-9._-]*$
export function isSafeName(name: string): boolean;                                            // one path segment: [A-Za-z0-9][A-Za-z0-9._-]*, no ".."
export function sanitizeSourceDir(name: string): string;                                      // NEW: `owner/repo` → `owner__repo`, `./agent-kit` → `agent-kit` (asset dir segment)
export const RUNTIME_VARS: ReadonlySet<string>; export function isRuntimeVar(name: string): boolean; export function isFillInValue(v: string): boolean; // placeholders.ts
export function scanHiddenUnicode(text: string): HiddenUnicodeFinding[];                      // unicode.ts, as in 0.1
```

## src/domain (owner: domain agent)

```ts
// source.ts: identity and naming of a source (was origin.ts)
export function sourceNameKind(key: string): 'github' | 'local' | 'named';                    // DESIGN §3 key rules: `.`, `..`, `./x`, `../x`, `/x` → local; `owner/repo` → github; three or more segments (`owner/repo/sub/dir`) → github with root
export function normalizeSource(name: string, raw: ManifestSource, baseDir: string, where: string): Source; // manifest key + body → Source (local path absolute in memory; url through validateSourceUrl; bad alias/ref → E_PARSE naming `where`)
export function toManifestSource(source: Source, baseDir: string): Pick<ManifestSource, 'url' | 'path' | 'root' | 'ref' | 'alias' | 'layout'>; // project-relative path, fixed key order
export class SourceRef {                                                                      // one Source with derived facts
  constructor(source: Source); static of(s: Source | SourceRef): SourceRef;
  readonly source: Source; get name(): string; get alias(): string | undefined; get isLocal(): boolean; get isGit(): boolean;
  get id(): string;                            // cache dir: <host>__<owner>__<repo>[__<root>] | local__<basename>-<hash8>; never the name
  get assetDir(): string;                      // sanitizeSourceDir(name): the `.palm/assets/<segment>` segment
  describe(): string;                          // local path | url[ (root)] (tables, messages)
  repoParts(): { owner?: string; repo: string };
  sameLocation(other: SourceRef): boolean;     // same url (case/.git/trailing slash aside) + root, or same resolved path
  matchRank(query: string): MatchRank;         // MatchRank = 0 | 1 | 2 | 3: 3 name or alias (any case); 2 exactly this source (owner/repo[/root], url or path with its root); 1 its repository or directory but not its root; 0 no match
  matches(query: string): boolean;             // matchRank(query) > 0
  indexFile(cacheDir: string, version: string /* sha or tree */): string; // <cacheDir>/<id>@<version8>[~<layout hash8>].index.json
  checkoutDir(cacheDir: string, sha: string): string;                     // <cacheDir>/<id>/sha-<sha>
}
export class SourceSet {                                                                      // immutable; names and aliases case-insensitive
  static of(sources?: Iterable<Source | SourceRef>, where?: string /* default palm.yaml */): SourceSet;
  static fromManifest(m: { toJSON(): Manifest }, baseDir: string, where: string): SourceSet;  // E_PARSE on a duplicate name/alias or a bad entry
  get size(): number; all(): SourceRef[]; names(): string[];
  byName(nameOrAlias: string): SourceRef | undefined;
  resolveQuery(query: string): SourceRef;       // highest SourceRef.matchRank wins: name/alias > exact location > repo only; E_NOT_FOUND (lists names) / E_AMBIGUOUS
  add(source: Source): SourceSet;               // same location → replaced in place (renamed, DESIGN §5 "Input forms"); other source with the name/alias → E_CONFLICT
  without(name: string): SourceSet;
}

// entity-ref.ts: `[kind:]name` on the command line and in only/exclude (was dep-ref.ts)
export const REF_GRAMMAR: string;                                                             // the E_USAGE hint
export function parseEntityRef(text: string): EntityRefSpec;                                  // `skill:tdd` → { kind, name }; `tdd` → { name }; bad kind word → E_USAGE; `name@x` or `#ref` → E_USAGE naming the new form
export function formatEntityRef(ref: EntityRef): string;                                      // `skill:tdd`
export function sameName(a: string, b: string): boolean;                                       // case-insensitive
export function isLegacyDepString(text: string): boolean;                                     // `name@alias`, `#ref`: old grammar (migrate hint)

// entity-key.ts: identities; `id` is the Map key, names lower-cased
export class EntityKey { static of(e: {kind, name}): EntityKey; readonly kind; name; get id(): string /* kind:name */; is(e): boolean; toString(): string }
export class LockKey { static of(e: {kind, name, source}): LockKey; get entity(): EntityKey; get id(): string /* kind:name@source */; is(e): boolean; toString(): string }
export function entityId(e: {kind, name}): string; export function lockId(e: {kind, name, source}): string;
export class Via { static parse(text): Via; static tryParse(text?): Via | undefined; static of(parent: {kind: 'plugin', name}): Via; readonly name: string; get key(): EntityKey; is(text?): boolean; toString(): string } // `plugin:<name>` only

// manifest.ts: palm.yaml v3; mutators change the object and return it
export function detectManifestFormat(raw: unknown): 3 | 'legacy' | 'empty';                    // legacy: `origins:` list, top-level kind lists, `name@alias` strings
export class Manifest {
  static of(data?: Manifest /* core */): Manifest;
  static async load(file: string): Promise<Manifest>;                                         // {} when missing; legacy → E_USAGE (hint `palm migrate`); malformed → E_PARSE naming the key
  async save(file: string): Promise<void>;                                                    // patches the file: comments, key order, flow `targets` survive; drops empty sections and entry-less sources
  get targets(): TargetId[] | undefined; setTargets(t: TargetId[]): this;
  sources(baseDir: string, where: string): SourceSet;
  sourceNames(): string[]; hasSource(name: string): boolean;
  addSource(source: Source, baseDir: string): this;                                           // by name; keeps existing entries
  removeSource(name: string): this;
  renameSource(from: string, to: string): this;                                               // same position, entries and options kept (DESIGN §5 rename)
  text(): string;                                                                             // what save writes for a fresh file (migrate --dry-run)
  entries(name: string, kind: Kind): ManifestEntryObject[];                                   // normalised (strings → objects)
  allEntries(): Array<{ source: string; kind: Kind; entry: ManifestEntryObject }>;
  hasEntry(name: string, kind: Kind, entity: string): boolean;                                // any case
  addEntry(name: string, kind: Kind, entry: ManifestEntry): this;                             // replaces same name; a string stays a string when it has no options
  removeEntry(name: string, kind: Kind, entity: string): this;                                // drops the section when empty, the source when entry-less
  excludeMember(name: string, plugin: string, member: EntityRef): this;                       // adds `kind:name` to the plugin entry's exclude
  get mcp(): Record<string, McpManifestEntry>; setMcp(name: string, e: McpManifestEntry): this; removeMcp(name: string): this;
  toJSON(): Manifest;
}
export function memberSelected(entry: ManifestEntryObject, member: EntityRef): boolean;        // only/exclude over `kind:name`

// lock.ts: palm.lock.yaml v3 as a collection keyed by LockKey
export const LOCK_VERSION = 3;
export interface LockPaths { abs(lockPath: string): string; lockForm(abs: string): string }   // ScopePaths fits
export interface RemovalPlan { removed: LockEntry[]; kept: Array<{ entry: LockEntry; via?: string }> }
export class Lock {
  constructor(sources?: Record<string, LockSource>, entries?: Iterable<LockEntry>);           // a repeated key keeps the first
  static from(lock: Lockfile): Lock;
  static async load(file: string): Promise<Lock>;                                             // empty when missing; version 1/2 → E_USAGE (hint `palm migrate`); entry without kind/name/source/path/content/render → E_PARSE
  static async loadLegacy(file: string): Promise<LegacyLockfile | undefined>;                 // migrate only: v1/v2 as data, undefined when missing
  async save(file: string): Promise<void>;                                                    // deterministic v3 (DESIGN §4); same lock → same bytes
  hash(): string;                                                                             // sha256 of the bytes `save` would write
  get sources(): Record<string, LockSource>; source(name: string): LockSource | undefined; setSource(name: string, s: LockSource): this; removeSource(name: string): this; renameSource(from: string, to: string): this /* entries follow */;
  get entries(): LockEntry[]; get size(): number; toJSON(): Lockfile;
  find(key: {kind, name}, source?: string): LockEntry | undefined; findAll(key: {kind, name}): LockEntry[];
  select(q: { kind?: Kind; name: string; source?: string }): LockEntry[];                     // user queries, any case
  upsert(entry: LockEntry): this; remove(key: {kind, name, source?}): this;
  childrenOf(parent: {kind, name}): LockEntry[]; parentOf(e: LockEntry): LockEntry | undefined;
  usersOf(dep: {kind, name}, leaving?: ReadonlySet<string>): LockEntry[];                     // plugins listing dep in `deps`
  planRemoval(roots: readonly LockEntry[], opts?: { listed?: (e: LockEntry) => boolean }): RemovalPlan; // members of a removed plugin go unless another plugin declares them
  reparent(kept: RemovalPlan['kept']): this;
  ownedPaths(): Set<string>;                                                                  // every lock-form file + `file#at#key`
  entriesOf(source: string): LockEntry[];
  trusted(entry: LockEntry): boolean;                                                         // exec absent, or exec.hash ∈ trust
  trust(entry: LockEntry, hash: string): this;                                                // adds to trust, dedupes
}
export function renderHashOf(rendered: Pick<Rendered, 'files' | 'fragments'>): string;         // DESIGN §4: sorted (path, mode, sha256(content)) + (file, at, key, canonicalJson(value));
//   takes lock-form input already tokenised by the target (home and PALM_HOME as <home> and <palm>, secret values as ${VAR} plus a literal-policy marker)
export function fragmentKey(at: string, value: unknown): string;                              // object key / table name / block id, or sha256:8 of the identity fields of an array item (DESIGN §4)
export function fragmentId(entry: {kind, name}, n: number): string;                           // palm:<kind>:<name>:<n>

// merged-record.ts: LockMerged (+ value) ⇄ tagged union used by targets
export type MergedRecord =
  | { type: 'json-item'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'json-key'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'toml-table'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'md-block'; file: string; id: string; key: string; content: string };
export function parseMergedRecord(stored: RenderedFragment): MergedRecord;                    // root / malformed pointer → E_INTERNAL
export function toLockMerged(rec: MergedRecord): LockMerged;
export type RecordState = 'held' | 'missing' | 'changed';

// scope-paths.ts
export const MANIFEST_FILE = 'palm.yaml', LOCK_FILE = 'palm.lock.yaml', LOCAL_MANIFEST_FILE = 'palm.local.yaml', APPLIED_FILE = 'applied.yaml';
export const TOKENS: readonly string[];                                                       // <home> <palm> <agents> <claude> <codex> <copilot> <cursor> <gemini> <opencode>
export function expandHomeDir(value: string | undefined, home: string): string | undefined;
export function homeOf(env: NodeJS.ProcessEnv): string; export function palmHomeOf(env: NodeJS.ProcessEnv, home: string): string;
export class ScopePaths {
  constructor(scope: Scope, root: string, palmHome: string, env: NodeJS.ProcessEnv);
  static of(ctx: { paths: PalmPaths; env: NodeJS.ProcessEnv }, scope: Scope): ScopePaths;
  static from(paths: PalmPaths, scope: Scope, env: NodeJS.ProcessEnv): ScopePaths;
  static at(scope: Scope, root: string, env: NodeJS.ProcessEnv): ScopePaths;  // for target calls that know only (scope, scopeRoot, env): PALM_HOME resolved from env
  readonly scope; root; palmHome; env;
  readonly home: string;                        // the user's home: the root at global scope, else from env
  get manifestFile(): string; get lockFile(): string; get localManifestFile(): string; get localLockFile(): string; // absolute
  get appliedFile(): string | undefined;        // global only: <palmHome>/applied.yaml
  get palmDir(): string;                        // <root>/.palm | palmHome
  get assetsDir(): string;                      // <palmDir>/assets
  get processLock(): string;                    // <palmDir>/lock (project) | <palmHome>/lock (global)
  assetRoot(source: SourceRef, entity: string): string; // lock form: .palm/assets/<segment>/<entity> | <palm>/assets/<segment>/<entity>
  harnessHome(id: TargetId): string;            // absolute: <root>/.<id> (project); override, else ~/.<id> (global; opencode: ~/.config/opencode)
  harnessOverride(id: 'claude' | 'codex' | 'copilot' | 'gemini' | 'opencode'): string | undefined; // the env override of a harness's global dir, when set
  token(id: TargetId | 'home' | 'palm' | 'agents'): string;    // the absolute dir a token expands to
  abs(lockPath: string): string;                // lock form → absolute (tokens expanded; a lock path with an unknown token → E_PARSE)
  lockForm(abs: string): string;                // project: posix relative; global: longest matching token, else E_IO (outside every boundary)
  boundaries(): string[];                       // project: [root]; global: [home, palmHome, ...harness homes]
  contains(abs: string): boolean;               // strictly inside a boundary
  safeAbs(lockPath: string): string | undefined; // abs(lockPath), or undefined when it would leave the boundaries (a tampered lock never deletes ../victim)
  async realInside(abs: string): Promise<{ real: string; inside: boolean; dangling: boolean }>; // lib realpathInside over boundaries()
  homes(): AppliedRecord['homes'];
}

// applied.ts: $PALM_HOME/applied.yaml
export class Applied {
  static async load(file: string): Promise<Applied>;                                          // empty when missing; malformed → treated as empty with a warning line returned by `warnings()`
  static fromLock(lock: Lock, paths: ScopePaths, hashes: Map<string /* abs */, string>): Applied;
  async save(file: string): Promise<void>;
  get record(): AppliedRecord; fileHash(abs: string): string | undefined; merged(): AppliedRecord['merged'];
  warnings(): string[];                                                                       // the line for an unreadable or malformed file
}

// ignore.ts: the one home for skip lists (as 0.1, minus HOOK_ASSET_*; INSTALL_OUTPUT_DIRS includes `.palm`; plus:)
export const CLOSURE_NEVER: readonly string[];        // SKILL.md, AGENTS.md, CLAUDE.md, GEMINI.md, marketplace.json, plugin.json, *-plugin, .git*, node_modules
export function isClosureExcluded(rel: string): boolean;
export function isTreeExcluded(rel: string): boolean; // a local source's tree hash (DESIGN §4): COPY_SKIP at any depth, install outputs and `.palm` at any depth, root repository files; no SCAN_IGNORE_DIRS
export const PLUGIN_ROOT_TOKENS: RegExp;              // ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_ROOT:-x} ${CLAUDE_PLUGIN_ROOT-x} $CLAUDE_PLUGIN_ROOT ${CURSOR_PLUGIN_ROOT} ${PLUGIN_ROOT} ${extensionPath}
export const PROJECT_DIR_TOKENS: RegExp;              // $CLAUDE_PROJECT_DIR ${CLAUDE_PROJECT_DIR} $CURSOR_PROJECT_DIR $GEMINI_PROJECT_DIR

// secret-refs.ts: the pure placeholder helpers (DESIGN §12; domain may import core/types). src/secrets/scan.ts re-exports them; targets import them from here
export function detectSecrets(cfg: McpServerConfig): SecretRef[];                             // which ${VAR} placeholders are user secrets (env, headers, url, args; runtime vars skipped; `Bearer ${T}` → format "Bearer {value}"; `${VAR:-x}` optional)
export function allSecrets(cfg: McpServerConfig): SecretRef[];                                // cfg.secrets ∪ detectSecrets(cfg), by name; declared entries win
export function requiredSecretNames(cfg: McpServerConfig): Set<string>; export function optionalSecretNames(cfg: McpServerConfig): Set<string>;

// source-url.ts: URL forms and `validateSourceUrl(url, where?)` (core/source-input.ts re-exports it)
```

## src/core (owner: domain agent)

```ts
// types.ts: the contract (among others: PalmContext.argv, PalmFlags.review, InstallRequest.as, ConsentRequest.operation and .read,
//   ScriptReader, ClosureFile.size, SourceReference.form 'unresolvable', McpServerConfig.from, RenderInput.targets, RenderedFragment.mode/ensure,
//   ApplyInput.scope, ApplyResult.files with `adopted` a subset, MigrateReport.failures).
// errors.ts: PalmError(code, message, hint?, { retryWith? }), retryHint, isPalmError, messageOf;
//   PalmErrorCode adds E_SOURCE (replaces E_ORIGIN), E_UNTRUSTED_EXEC, E_SECRET, E_CHECK.
// kinds.ts
export type Resource = Kind | 'source' | 'target' | 'all';
export function parseKind(word?: string): Kind | undefined;                                   // singular, plural, short (sk ag ins hk mcp pl); `command(s)`/`cmd`/`prompt(s)` → 'skill'
export function parseResource(word?: string): Resource | undefined;                           // + source(s)/src, target(s)/tg, all; origin(s)/orig → 'source'
export function resourceWords(resource: Resource): string[];
export function manifestKey(kind: Kind): 'skills' | 'agents' | 'instructions' | 'hooks' | 'mcp' | 'plugins';
export function pluralize(kind: Kind, n: number): string;
export function isCommandWord(word?: string): boolean;                                        // `command`, `commands`, `cmd`, `prompt(s)`: the "installs as a skill" note

// paths.ts
export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv): PalmPaths;                // PALM_HOME `~` expanded; projectRoot per DESIGN §2 (stops at .git)
export function isHomeAsProject(paths: PalmPaths, env: NodeJS.ProcessEnv): boolean;
export function enclosingProject(cwd: string, stopAt: string): string | undefined;            // NEW: a palm.yaml above cwd inside the same repository (init refuses without --here)

// context.ts
export interface ContextInit { cwd: string; env: NodeJS.ProcessEnv; ui: UI; log: Logger; flags: PalmFlags }
export async function createContext(init: ContextInit): Promise<PalmContext>;                 // no config; reads nothing; installs the lib git runner (setGitRunner → runGit). The CLI sets `ctx.argv` (the command line as typed) afterwards
export function scopedPaths(ctx: PalmContext, scope: Scope): ScopePaths;
export async function withScopeLock<T>(paths: ScopePaths, fn: () => Promise<T>): Promise<T>;  // DESIGN §2 advisory lock (reuses git withLock); dry runs and read-only commands skip it

// source-input.ts (was origin-input.ts): CLI input → Source (name derived per DESIGN §5 "Input forms")
export interface ParseSourceOptions { as?: string; ref?: string; root?: string; layout?: LayoutDescriptor; cwd?: string; projectRoot?: string }
export function parseSourceInput(input: string, opts?: ParseSourceOptions): Source;          // `#ref` suffix; local paths absolute; a path outside projectRoot → E_SOURCE; a bare word that is nothing → E_USAGE with the DESIGN §10 "not a repository" text
export function looksLikeSourceInput(word: string): boolean;                                  // owner/repo, URL, path, github:
export function validateSourceUrl(url: string, where?: string): { warning?: string };        // re-exported from domain/source-url.ts
export function deriveSourceName(source: Source, existing: readonly string[]): string;        // owner/repo (a subdirectory: owner/repo/sub/dir, root stored) | repo | owner-repo | -2…; local: ./rel

// git.ts (as 0.1, renamed): fetchSource(ctx, source, opts?: { sha?: string; refresh?: boolean; exclude?: ReadonlySet<string> }): Promise<SourceCheckout>
//   git: `sha` taken as is, else the ref intent (a cache hit unless `refresh`, else resolveRef); each commit fetched once into
//   checkoutDir(sha) (withLock) with the record `sha-<sha>.json` beside it (url, sha, fetchedAt, the ref intents that resolved to it);
//   `--offline` never touches the network (E_NETWORK when the cache lacks it). local: realpath + treeHash with isTreeExcluded,
//   `exclude` adding source-relative paths to leave out (the lock-owned paths of a source at `.`)
export async function withLock<T>(file: string, fn: () => Promise<T>, opts?: { timeoutMs?; staleMs? }): Promise<T>; // lock-file.ts, re-exported by git.ts
export async function listRemoteRefs(url: string): Promise<{ tags: string[]; heads: string[]; headShas: Record<string, string>; tagShas: Record<string, string> }>;
export function latestSemverTag(tags: string[]): string | undefined; export function isSemverRange(ref: string): boolean; export function maxSatisfyingTag(tags: readonly string[], range: string): string | undefined;
export async function resolveRef(url: string, ref: string | undefined): Promise<{ ref: string; resolved: string; sha: string }>; // DESIGN §5 "Refs"; no ref → `^M.m` of the latest release tag, else the default branch
export async function commitDate(checkoutDir: string, sha: string): Promise<string | undefined>; // NEW: author date for the consent header
export async function fileAtSha(checkoutDir: string, sha: string, rel: string): Promise<string | undefined>; // NEW: `git show <sha>:<rel>` for the viewer and diff
// git-exec.ts: unchanged (runGit, GitCall, cleanGitEnv, gitArgs, NETWORK_TIMEOUT_MS, LOCAL_TIMEOUT_MS, GitFailure, isGitTimeout, withBatchMode, isSshUrl)

// cache.ts: the scanner is always injected
export const INDEX_FORMAT = 3;
export async function getIndex(ctx: PalmContext, checkout: SourceCheckout, opts: { scan: EngineDeps['scan']; refresh?: boolean }): Promise<SourceIndex>; // keyed by sha or tree + layout
export async function readCachedIndex(ctx: PalmContext, source: SourceRef, version: string): Promise<SourceIndex | undefined>;
export function cacheDir(paths: PalmPaths): string;                                          // `$PALM_HOME/cache` (lives here, in core/cache.ts)
export async function ensureCacheDir(dir: string): Promise<void>;                            // mode 0700 (DESIGN §8)
export async function cleanCache(paths: PalmPaths): Promise<{ removedBytes: number }>;

// hash.ts
export async function hashPath(absPath: string, opts?: { boundary?: string }): Promise<string>; // "sha256:<hex>", as 0.1 (CRLF → LF for text, COPY_SKIP left out, symlinks only inside boundary)
export async function treeHash(root: string, opts: { skip: (rel: string) => boolean; boundary?: string }): Promise<{ tree: string; files: ClosureFile[] }>; // NEW: DESIGN §4 "Source tree hash" (also the closure Merkle hash)
export function sha256(data: string | Uint8Array): string;                                    // "sha256:<hex>" (re-exported from lib/digest.ts)
export function short(hash: string, n?: number): string;                                      // `sha256:a7cc7911…` → `a7cc7911` (re-exported from lib/digest.ts)
```

## src/index (owner: index agent)

```ts
// scan.ts: the only entry point the rest of palm uses
export async function scanSource(root: string, source: Source): Promise<ScanResult>;
// Rules, names, activation, one walk: DESIGN §5. Commands are skills: adders.ts `addCommandAsSkill` builds
//   { kind: 'skill', path: <file>, def: { kind: 'skill', skill: { name, description, fromCommand: { body, argumentHint, sourceFormat } } }, notes: ['from command <file>'] }
// references.ts (NEW)
export function findReferences(raw: unknown, site: 'hook' | 'mcp', opts: { hooksDirRel: string; pluginRootRel?: string; files: FileIndex }): SourceReference[];
//   every plugin-root, relative and project-dir reference in commands/args/cwd, resolved against the source (DESIGN §2 "Relocation");
//   `eval`, `$(…)`, backticks, `~/` and `$HOME/` get form `unresolvable` with `unresolved` set; each unresolved one becomes a critical `unresolvable-reference` issue
export function closureOf(refs: SourceReference[], opts: { hooksDirRel?: string; files: FileIndex }): Closure;
//   the hooks file's directory + every resolved `rel` at the level named, CLOSURE_NEVER removed, sorted, deduped (a dir swallows its files)
// secrets pass: for every mcp entity and hook set, index/secrets.ts calls src/secrets (scanSecrets, scanText, redact, detectSecrets,
//   injected by scan.ts as a `SecretScanner`; index → secrets is allowed, DESIGN §12) on env/headers/args/url/commands and on closure
//   files; findings become `secret-literal` issues (a warning inside a closure file) and values are replaced by `<redacted sha256:8>`
//   in the entity def. A literal is not a refusal: the render writes `${KEY}` and the summary names the variable (DESIGN §8)
// marketplace.ts: findMarketplaceFile(root) stays; parseMarketplace is gone (a marketplace is a scan rule only)
// agents.ts / instructions.ts / commands.ts / hooks.ts / mcp.ts / skills.ts
export function parseAgentFile(absPath: string, text: string): AgentDefinition;
export function parseInstructionFile(absPath: string, text: string): InstructionDefinition;   // sets `activation` (DESIGN §5)
export function parseCommandFile(absPath: string, text: string): { name: string; description?: string; command: CommandAsSkill };
export function parseHooksJson(name: string, json: unknown, pluginRootRel?: string): Omit<HookSet, 'references' | 'closure' | 'promptHooks'> & { promptHooks: HookSet['promptHooks'] };
export function parseMcpJson(json: unknown): McpServerConfig[];                               // wrapped `mcpServers`, VS Code `servers`, or flat
export function parseSkillMd(dirName: string, text: string): SkillDefinition;
```

Internal layout as in 0.1 (`scanner.ts`, `detect.ts`, `rules/*`, `scan-context.ts`, `files.ts`,
`glob.ts`, `entity-registry.ts`, `adders.ts`, `plugin-components.ts`, `hidden-unicode.ts`) plus
`references.ts` and `secrets.ts`. Nothing outside src/index imports the internals.

## src/secrets (owner: exec-and-secrets agent)

```ts
// scan.ts
export const SECRET_PREFIXES: readonly string[];                                              // sk- ghp_ github_pat_ gho_ xoxa- xoxb- xoxp- AKIA AIza glpat- -----BEGIN
export const SECRET_KEY_RE: RegExp;                                                           // /(key|token|secret|password|authorization)/i
export function looksLikeSecret(value: string, key?: string): SecretShape | undefined;        // DESIGN §8 shapes; `${VAR}` references and runtime vars never
export function scanSecrets(value: unknown, where: string): SecretFinding[];                  // walks strings in objects/arrays (MCP config, hook JSON, palm.yaml data); `where` prefixes each finding
export function scanText(text: string, where: string): SecretFinding[];                       // closure files and rendered files, line-numbered `where:<line>`
export function redact(value: string): string;                                                // `<redacted sha256:8>`
export { detectSecrets, allSecrets, requiredSecretNames, optionalSecretNames } from '../domain/secret-refs.js'; // the pure placeholder helpers live in domain (see there)
// policy.ts
export interface SecretDestination { scope: Scope; fromSource: boolean; requested?: SecretPolicy; destinationAbs: string; force: boolean }
export interface GitProbe { gitToplevel(dir: string): Promise<string | undefined>; isGitIgnored(abs: string, cwd: string): Promise<boolean | undefined> } // tests pass fakes
export async function decideSecret(input: SecretDestination, git?: GitProbe /* default: lib gitToplevel, isGitIgnored */): Promise<SecretDecision>;
//   fromSource → refused: the literal is never written, `force` or not (the render writes `${VAR}`; not a refusal of the entity);
//   no `--secrets literal` → env-ref; project + literal → literal, `warn` when the destination is inside a git worktree and not ignored (git would commit it);
//   global + literal → literal only when gitToplevel(nearest existing dir of the destination realpath) is undefined, else refused (hint `--secrets env-ref`; `force` → warn)
export function rotateMessage(input: RotateInput): string;                                    // RotateInput { server; file; key; variable; tracked: boolean; harnesses: string[] }
// resolve.ts
export async function resolveSecrets(ctx: PalmContext, cfg: McpServerConfig, policy: SecretPolicy): Promise<{ values: Record<string, string>; envRefs: string[] }>; // env lookup; masked prompts under literal on a terminal; E_NON_INTERACTIVE otherwise (retryWith `--secrets env-ref`)
```

## src/exec (owner: exec-and-secrets agent)

```ts
// units.ts
export function execUnitOf(entity: Entity, renders: Partial<Record<TargetId, Rendered>>, closure: { root: string; inPlace: boolean; files: ClosureFile[] }, from?: ExecUnit['from']): ExecUnit;
//   commands from every render's `exec` (id + canonical, one per (id, canonical), TARGET_IDS order); ids `<Event>//<matcher|->[#n]` in Claude
//   event names for hooks, `stdio` for MCP; hash per DESIGN §7; key `<hook|mcp>:<name>@<source>`; in-place (in-repo) closures list no files; bytes summed
export function execHash(input: { commands: ExecUnit['commands']; env?: string[]; cwd?: string; closureTree: string }): string;
export function closureTree(files: readonly ClosureFile[]): string;                           // Merkle hash over sorted (path, executable bit, content hash)
export function unitKey(entity: { kind: Kind; name: string; source: string }): string;       // `mcp:<name>@manifest` for a server declared under `mcp:` in palm.yaml
export function isExecutable(entity: Entity): boolean;                                        // hook with at least one command hook, or stdio mcp
export function firstTarget(unit: ExecUnit): TargetId | undefined;                            // first target (TARGET_IDS order) that renders the unit
export function commandAt(unit: ExecUnit, target: TargetId | undefined, i: number): string;  // the command line `target` runs for command i, else its canonical text
export async function execFrom(checkout: SourceCheckout): Promise<ExecUnit['from']>;         // sha, the ref it was resolved from, author date; undefined for a local checkout
// consent.ts (ScriptReader is in core/types.ts: (unit, file) => Promise<string | undefined>)
export function parseAllowExec(text: string | undefined): AllowExec[] | 'all';                 // comma-separated `<hook|mcp>:<name>@<source>=sha256:<hash>` (a prefix of at least 16 hex); malformed → E_USAGE with the format
export function allowed(unit: ExecUnit, allow: AllowExec[] | 'all'): boolean;                 // its key (any case) with a prefix of its hash, or `all`
export function consentText(req: ConsentRequest, opts: PromptOptions): string;                // prompt.ts, re-exported; PromptOptions { scope: Scope; lockFile: string /* as shown */ }; DESIGN §7 prompt, verbatim layout; header per req.operation
export function nonInteractiveError(req: ConsentRequest, argv: { args: readonly string[] }): PalmError; // E_UNTRUSTED_EXEC: `review:` repeats the command plus `--dry-run --review`, `then:` repeats it plus the full-hash `--allow-exec` entries
export async function askConsent(ctx: PalmContext, req: ConsentRequest): Promise<ConsentOutcome>;
//   units already covered by ctx.flags.allowExec pass; none left → { allowed, declined: [] } without a prompt;
//   `all` without a terminal → E_USAGE; a dry run shows the units and asks nothing; no terminal → nonInteractiveError (with ctx.argv);
//   otherwise ctx.ui.consent loop: `v` → viewScripts, `d` → execDiff, then ask again. `ctx.flags.review` pages every script body first
export async function viewScripts(ctx: PalmContext, units: ExecUnit[], read: ScriptReader): Promise<void>; // paged through Output.page, bodies from the cache at the pinned sha
export function checkoutReader(locate: (unit: ExecUnit) => { checkoutDir: string; dirRel: string } | undefined): ScriptReader; // bodies via `git show <sha>:<dirRel>/<path>` (the engine passes it as ConsentRequest.read)
export async function execDiff(units: readonly ExecUnit[], previous: Record<string, ExecUnit> | undefined, read: ScriptReader): Promise<string>; // review.ts, re-exported: commands, env keys, cwd and every changed script against the trusted unit (`d`, `update --review`)
export function unifiedDiff(a: string, b: string, name: string): string;                       // diff.ts, re-exported
// trust.ts
export function needsConsent(entry: LockEntry | undefined, unit: ExecUnit, opts?: { explicit?: boolean }): boolean; // no entry, no trust, or unit.hash ∉ trust; a declined entry only when asked by name (`explicit`)
export function withTrust(entry: LockEntry, unit: ExecUnit): LockEntry;                       // exec (commands as the first target renders them, closure, hash) + trust recorded; a previous decline is lifted
export function withDeclined(entry: LockEntry): LockEntry;
```

## src/targets (owner: targets agent)

```ts
// index.ts
export function getTarget(id: TargetId): Target; export function allTargets(): Target[];
export function createTarget(id: TargetId, env?: NodeJS.ProcessEnv): GenericTarget;
export const PROJECT_DIR: Record<TargetId, string>;                                           // DESIGN §2 relocation table (quoted idioms)
// placements.ts (NEW): Target.placements(at: { scope; scopeRoot; env }, active: TargetId[]) → Array<{ kind; where }> (types.ts, optional on Target):
//   where each installable kind goes at a scope, lock form with `<name>` (DESIGN §10 `describe target`); the shared skills dir follows `active`
// layout.ts: TargetSpec { id; displayName; layout(paths: ScopePaths): TargetLayout; detect(paths: ScopePaths): Promise<boolean>; outputDirs(paths: ScopePaths): string[] /* lock form */ }
//   one per harness (claude.ts, codex.ts, copilot.ts, cursor.ts, gemini.ts, opencode.ts). TargetLayout as 0.1 minus commands, plus `skillsDir(active: TargetId[])`
//   (cursor: .claude/skills when claude is active, else .agents/skills).
// base.ts: GenericTarget implements Target: render() runs the kind renderer into a Rendered (no writes; reads the source and the
//   closure); apply() runs the Applier; undeploy() removes entry.files inside this target's roots and the assets dir and unmerges entry.merged by (at, key).
// render.ts (was plan.ts + planners.ts): RENDERERS: Record<Kind, (job: RenderJob) => Promise<void>>; a RenderJob collects files (lock form,
//   bytes, mode; the closure files included, read with readClosure), fragments (MergedRecord with id + key + value, plus `mode`, `ensure`,
//   `createMode`), exec lines and notes into a Rendered; `hash` = renderHashOf over lock-form input: home and PALM_HOME tokenised as
//   <home>/<palm>, secret values as their ${VAR} plus a literal-policy marker (DESIGN §4). RenderInput.targets (the entry's active targets)
//   decides shared directories (cursor writes .claude/skills when claude is active). Secret placeholder helpers come from domain/secret-refs.ts.
//   Fragment values are computed from the render alone: a merge never reads the disk at render time (the Applier merges into the file it finds).
// apply.ts (the Applier): collision policy (a whole file that exists, is not in `owned`, and differs → E_CONFLICT before any write; identical →
//   adopted), then fragments (read the shared file once, insert by (at, key): a held identical fragment is a no-op, a different one under the same
//   key is E_CONFLICT unless owned or force; `ensure` keys set when missing; `mode` set even on an existing file), then whole files; journaling and
//   rollback as DESIGN §2. ApplyInput.scope: a global render checks every boundary. ApplyResult.files lists every lock path of the render (written,
//   adopted, or that would be in a dry run); `adopted` is the subset present with identical content. Dry run: no writes, same result.
// assets.ts (NEW)
export async function readClosure(sourceRoot: string, closure: Closure, boundary?: string): Promise<Array<{ rel: string; mode: number; data: Buffer }>>; // sorted, deduped, isClosureExcluded left out inside directories; `rel` is source-relative and also the path below the asset root
export async function copyClosure(input: { sourceRoot: string; closure: Closure; destAbs: string; boundary: string }): Promise<ClosureFile[]>; // migrate only; dereferences symlinks inside the source, preserves modes, refuses a link leaving the source (E_SOURCE)
export function assetRootFor(paths: ScopePaths, source: SourceRef, entity: string, inPlace: boolean): string; // lock form
// relocate.ts (NEW)
export function relocateCommand(command: string, refs: SourceReference[], target: TargetId, opts: RelocateOptions): { canonical: string; rendered: string };
//   RelocateOptions { assetsRoot: string /* lock form */; scope: Scope; env?: NodeJS.ProcessEnv /* `<palm>` as $HOME/.palm or ${PALM_HOME:-$HOME/.palm} */; powershell?: boolean /* no VAR= prefix */ }
//   canonical: placeholders intact, relative paths rewritten to `${PLUGIN_ROOT}/<rel>`; rendered: `<PROJECT idiom>/<assetsRoot>/<rel>` quoted (`rel` source-relative;
//   each `ref.raw` replaced verbatim), project-dir tokens translated; a command that names the plugin root is prefixed with the harness's root
//   variables set to `<PROJECT>/<assetsRoot>/<plugin root rel>` (DESIGN §2). An unresolved reference is E_SOURCE
export function relocateMcp(cfg: McpServerConfig, refs: SourceReference[], target: TargetId, opts: { assetsRoot: string; scope: Scope; absolute?: (lockPath: string) => string; home?: string }): { cfg: McpServerConfig; canonical: string; rendered: string };
// convert-agent.ts
export function renderAgent(def: AgentDefinition, target: TargetId): { fileName: string; content: string; dropped: string[]; notes?: string[] };
// convert-instruction.ts
export function renderInstruction(def: InstructionDefinition, target: TargetId): { fileName: string; content: string } | { managedBlock: string };
// convert-skill.ts (NEW): renderCommandAsSkill(def: SkillDefinition & { fromCommand: CommandAsSkill }, target: TargetId): { content: string; notes: string[] } // SKILL.md text; `$ARGUMENTS` note per harness
// convert-hooks.ts
export function convertHooks(hooks: HookSet, target: TargetId, relocate: (command: string, opts?: { powershell?: boolean }) => { canonical: string; rendered: string }): { hooks: unknown; exec: Rendered['exec']; dropped: string[] }; // dialect conversion as 0.1; every command line goes through `relocate`; `exec` ids are `<Event>//<matcher|->[#n]` in Claude event names and tool matchers, the same for every target
// tool-names.ts: unchanged (geminiTool, hookMatcher, copilotTool, opencodePermission, opencodeServerPattern, hasToolArgument)
// mcp-config.ts
export function renderMcp(cfg: McpServerConfig, target: TargetId, policy: SecretPolicy, opts?: { values?: Record<string, string>; scope?: Scope }): { entry: Record<string, unknown> | undefined; notes: string[]; envRefs: string[] }; // entry undefined when the harness cannot express the server
// json-merge.ts, toml-merge.ts, managed-block.ts: pure text transforms as 0.1, keyed by (path, key): setKeyText, appendItemText (no-op when an item with the same key exists and deep-equals), ensureKeyText, mergeTableText, upsertBlockText, and the unmerge/record-state functions
export function jsonRecordState(text: string | undefined, rec: MergedRecord): RecordState; export function tomlRecordState(...): RecordState; export function blockState(...): RecordState;
// merged-state.ts: mergedRecordState(rec: MergedRecord /* file absolute */): Promise<RecordState> (held when the fragment found by key deep-equals what palm would write, `${VAR}` matching any text; changed otherwise; missing when the key is absent)
//   mergedRecordValue(rec): Promise<unknown> (what the file holds under the key, a block ending with the newlines of rec.content; undefined when absent or unparseable)
// render-hash.ts: renderHash(files, fragments, form: HashForm { scope; paths; secretPolicy?; secretValues? }): string, the render hash RenderJob records
//   and the engine recomputes over the disk (tokens under -g, secret values as ${VAR} plus the literal-policy marker)
```

## src/engine (owner: engine agent)

```ts
// deps.ts
export async function resolveEngineDeps(partial?: Partial<EngineDeps>): Promise<EngineDeps>; // lazily imported defaults (scanSource, getTarget, execUnitOf, askConsent, scanSecrets, decideSecret, resolveSecrets)
// scope.ts
export interface ScopeState { paths: ScopePaths; manifest: Manifest; lock: Lock; sources: SourceSet; targets: TargetId[]; applied?: Applied }
export async function openScope(ctx: PalmContext, scope: Scope, opts?: { readOnly?: boolean; deps?: EngineDeps }): Promise<ScopeState>;
//   guards (DESIGN §2), lock + manifest load (E_USAGE migrate), targets (manifest, else detection when `deps` is given; not saved here),
//   a declared local source outside the project → E_SOURCE, and unless `readOnly` the overlap check of every local source against the
//   outputDirs of active targets (E_SOURCE). `readOnly` has no side effects
export async function saveScope(state: ScopeState, opts?: { manifest?: boolean; lock?: boolean }): Promise<void>; // only when JSON.stringify changed; global: rewrites applied.yaml with the lock
export async function persistTargets(state: ScopeState): Promise<boolean>;                    // writes `targets:` when the manifest has none; true when written
// resolve.ts
export interface ResolveJob { ctx: PalmContext; deps: EngineDeps; state: ScopeState; ref: SourceRef; sha?: string; refresh?: boolean }
export async function resolveSource(job: ResolveJob): Promise<{ checkout: SourceCheckout; index: SourceIndex }>; // one options object (the 4-parameter shape rule)
//   locked sha when given (bare install), else the ref intent; one fetch per source and sha per run; a local source at the scope root is hashed with the lock-owned paths excluded (fetchSource `exclude`)
export async function declareSource(ctx: PalmContext, state: ScopeState, input: string, opts: { as?: string; yes: boolean }): Promise<SourceRef>;
//   DESIGN §5 "Input forms": declared → itself (another `#ref` moves the intent after confirmation; a new `--as` name for an already declared location
//   renames the source in palm.yaml and the lock: `~ source <old> → <new> (renamed)`); else parse, add to the manifest with the ref written explicitly
//   and reported (`^M.m` of the latest release tag, else the default branch)
export function matchNames(index: SourceIndex, names: EntityRefSpec[], all: boolean): NameMatch; // NameMatch { entities: Entity[]; plugins: Array<{ plugin: Entity; members: Entity[] }>; missing: EntityRefSpec[]; ambiguous: EntityRefSpec[] }
// render.ts
export async function renderEntity(ctx: PalmContext, deps: EngineDeps, state: ScopeState, job: RenderJob): Promise<RenderOutput>;
//   RenderJob { entity: Entity; source: SourceRef; checkout: SourceCheckout; targets: TargetId[]; policy: SecretPolicy; values?: Record<string, string> }
//   RenderOutput { renders: Partial<Record<TargetId, Rendered>>; closure: { root: string; inPlace: boolean; files: ClosureFile[] }; content: string; unit?: ExecUnit; refusals: InstallFailure[]; warnings: string[] }
//   refusals: critical hidden-Unicode and unresolvable-reference issues, a secret decision `refused` for a typed literal (a literal from a source renders as `${KEY}`, DESIGN §8);
//   warnings: scan warnings (zero-width characters, a literal inside a script) and secret notices. Before apply, every rendered path's real path is
//   checked against the declared local sources' real paths: a hit is E_SOURCE for that entity (DESIGN §2)
// diff.ts: the three-way diff (DESIGN §6 "Bare install")
export type FileState = 'same' | 'missing' | 'modified' | 'foreign' | 'stale'; // stale: differs, but is exactly what palm last wrote here (global scope, applied.yaml)
export async function fileStates(paths: ScopePaths, rendered: Rendered, opts?: { applied?: Applied }): Promise<Map<string /* lock path */, FileState>>; // disk vs render; global: applied hashes decide `modified`, `foreign` or `stale`
export function fragmentKey(f: { file: string; at: string; key: string }): string;           // `file#at#key`
export async function fragmentStates(paths: ScopePaths, rendered: Rendered, deps?: EngineDeps): Promise<Map<string /* file#at#key */, RecordState>>;
export function outcomeStatus(input: OutcomeInput): { status: OutcomeStatus; toWrite: TargetId[]; kept: string[] }; // pure
//   OutcomeInput { previous?: LockEntry; renders; files: Map<string, FileState>; fragments: Map<string, RecordState>; force: boolean;
//   content?: string /* now: another is `updated`, the same `re-rendered` */; edited?: Set<string> /* paths and fragment keys found edited against the lock's render hash (DESIGN §6 step 8): kept; an edited file the render no longer writes is kept too */ }
// edits.ts: what the person changed when the render moved away from the lock (DESIGN §6 step 8, PLAN.md invariant 7)
export async function knownEdits(run: Run, input: EditInput): Promise<EditCheck | undefined>; // undefined: the render did not move, or --force
//   EditInput { previous; out: RenderOutput; files; fragments /* disk vs the new render */; values? /* literal secret values */ }
//   EditCheck { edited: Set<string>; unchecked?: { reason: string; command: string } }: at risk are owned paths the new render overwrites or drops;
//   1. offline: per target, the disk (files as renderHashOf hashes them, fragments read by key with mergedRecordValue) hashed with renderHash
//   against render.<target>; 2. the render at the locked sha, per file; 3. neither decides: every path at risk kept, `unchecked` names why
export function uncheckedNote(u: Unchecked): string; // `locked commit <sha7> unavailable; palm install <source> <kind:name> --force overwrites`
// install.ts
export async function installFromSource(ctx: PalmContext, req: InstallRequest, opts: InstallOptions, deps?: Partial<EngineDeps>): Promise<InstallResult>; // DESIGN §6 "Install with names" (InstallRequest.as: `--as`); the CLI calls listSource instead when the request has no names and no `all`
//   programs left out by `all` or declined come back as outcomes whose entry has `declined: true`; the engine prints nothing itself (the CLI prints)
export async function listSource(ctx: PalmContext, input: string, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<{ source: SourceRef; checkout: SourceCheckout; index: SourceIndex; declared: boolean }>; // fetch + index, save nothing; checkout.ref is the resolved tag
export async function installMcp(ctx: PalmContext, reqs: McpRequest[], opts: InstallOptions & { force?: boolean }, deps?: Partial<EngineDeps>): Promise<InstallResult>; // `mcp:` entries: secrets typed by the user (decideSecret with fromSource false), consent for stdio, E_CONFLICT on an existing name unless force
export function requestInstallStop(): void;                                                   // SIGINT: stop after the current entity
// sync.ts
export async function syncScope(ctx: PalmContext, opts: InstallOptions, deps?: Partial<EngineDeps>): Promise<InstallResult>; // DESIGN §6 "Bare install"
// remove.ts
export async function removeEntities(ctx: PalmContext, refs: Array<EntityRefSpec & { source?: string }>, opts: InstallOptions & { exclude?: boolean }, deps?: Partial<EngineDeps>): Promise<RemoveResult>; // DESIGN §6 "Remove"; RemoveResult.kept?: KeptFiles[] names the files it left (owned by another entry, or inside a declared source)
export async function undeploy(ctx: PalmContext, deps: EngineDeps, job: UndeployJob): Promise<{ failures: InstallFailure[]; warnings: string[] }>;
//   UndeployJob { paths: ScopePaths; entries: LockEntry[]; protect: Set<string> /* lock form + file#at#key */; dryRun: boolean; sources?: string[] /* real paths of local sources: never deleted inside */ }
// update.ts
export async function planUpdate(ctx: PalmContext, sources: string[], opts: { scope: Scope; to?: string }, deps?: Partial<EngineDeps>): Promise<UpdatePlan>; // nothing written; local sources `skipped`; UpdatePlan.sources[].latest?: the newest tag for a pinned source
export async function applyUpdate(ctx: PalmContext, plan: UpdatePlan, opts: { scope: Scope; to?: string }, deps?: Partial<EngineDeps>): Promise<InstallResult>; // consent through askConsent for plan items with `exec`; moves manifest refs with `to`
export function planChanges(plan: UpdatePlan): number;
export async function reviewText(ctx: PalmContext, plan: UpdatePlan, deps: EngineDeps): Promise<string>; // `--review`: script diffs (0.2) [+ prose diffs 0.3]
// check.ts
export async function checkScope(ctx: PalmContext, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<CheckReport>; // DESIGN §6 "Check": every check, read-only, git checks skipped outside a repository
// migrate.ts
export async function migrateScope(ctx: PalmContext, opts: { scope: Scope; dryRun: boolean }, deps?: Partial<EngineDeps>): Promise<MigrateReport>; // DESIGN §6 "Migrate"; reads LegacyManifest/LegacyLockfile/LegacyConfig;
//   MigrateReport.manifest is the new palm.yaml text; MigrateReport.failures: what could not be migrated (the CLI exits 1 on any); the only user of copyClosure
// query.ts
export interface InstalledRow { entry: LockEntry; source: LockSource; layer: 'team' | 'local' }
export interface EntityInfo { entry: LockEntry; entity?: Entity; source: LockSource; files: Partial<Record<TargetId, string[]>>; notes: string[]; exec?: { commands: LockExec['commands']; hash: string; trusted: boolean }; secrets?: Array<{ name: string; set: boolean }>; selectedBy: string /* manifest | plugin:<n> */; blocks?: Partial<Record<TargetId, Array<{ file: string; at: string; value: unknown }>>> /* an MCP server's block per harness */ }
export async function listInstalled(ctx: PalmContext, scope: Scope, q?: { kind?: Kind; names?: string[]; source?: string }): Promise<InstalledRow[]>;
export async function describeEntity(ctx: PalmContext, q: EntityRefSpec & { source?: string }, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<EntityInfo>;
export async function ownerOfPath(ctx: PalmContext, query: string, opts: { scope: Scope }): Promise<Array<{ entry: LockEntry; match: 'file' | 'inside' | 'merged'; file: string }>>;
export async function loadCost(ctx: PalmContext, scope: Scope): Promise<Partial<Record<TargetId, { bytes: number; entries: number }>>>; // 0.3 footer; 0.2 returns {} (reserved)
// targets.ts
export async function detectTargets(ctx: PalmContext, paths: ScopePaths, deps: EngineDeps): Promise<TargetId[]>;
export function activeTargets(state: ScopeState, entry?: ManifestEntryObject): TargetId[];   // scope set narrowed by the entry
```

## src/cli.ts, src/commands/*, src/ui/*, src/create/* (owner: cli agent)

`src/cli.ts` only calls `runCli` and exits. The command tree is registration only: every action
builds an `Invocation` and hands it to a dispatcher that imports the command module lazily.

```ts
// commands/main.ts
export const EXIT: { ok: 0; failure: 1; usage: 2; cancelled: 130 };
export function exitCodeFor(e: unknown): number;               // CommanderError → 2 (0 for help/version), ExitSignal → its code, E_USAGE → 2, E_CANCELLED → 130, every other error → 1 (non-PalmError: printed with the "palm bug" line)
export async function runCli(argv: string[], opts?: CliOptions): Promise<number>;
//   CliOptions { version?; stdout?: Sink; stderr?: Sink; stdin?: NodeJS.ReadableStream /* for `install mcp --snippet -` */; isTTY?: boolean /* colour, pager */;
//   ui?: UI; cwd?; env?; deps?: CliDeps /* engine collaborators and fakes of engine operations */; dispatch?: Dispatch /* grammar tests */;
//   exit?: (code: number) => void /* src/cli.ts: given, runCli handles Ctrl-C */ }
// commands/grammar.ts (pure; loaded by --help)
export type Verb = 'init' | 'install' | 'remove' | 'update' | 'check' | 'get' | 'describe' | 'create';
export const VERBS: readonly VerbSpec[];                       // name, aliases, summary, arguments
export interface Invocation { command: string; resource?: Resource; source?: string; names: EntityRefSpec[]; opts: Record<string, unknown>; legacy?: { form: string; replacement: string }; words?: string[] /* the positional words as typed; install and remove read them again with palm.yaml at hand */ }
export type Dispatch = (inv: Invocation) => Promise<void>;
export function interpretInstall(words: string[], ctx?: GrammarContext): InstallWords; // InstallWords { source?; names; mcp?; legacy? }; DESIGN §10: first word = source or `mcp`; `name@alias` legacy (legacy.ts); `install origin` legacy; with isDeclared, a bare word → the not-a-source errors (not-a-source.ts)
//   GrammarContext (hints.ts) { isDeclared?; scope?; sources?: KnownSource[]; entries?; localDir?(word); legacyAliases? /* ~/.palm/config.yaml */; projectSources? /* under -g */ }, built by known.ts grammarContext(ctx, app, state, words)
export function interpretWords(verb: 'get' | 'describe', words: string[]): { resource?: Resource; names: EntityRefSpec[]; legacy?: Invocation['legacy'] };
export function interpretRemove(words: string[], ctx?: GrammarContext): InstallWords;  // first word is a source when it matches looksLikeSourceInput, or palm.yaml declares it and names follow
// commands/hints.ts (pure): palmLine(verb, words, scope) → `palm <verb> …[ -g]`; exampleLine(form, example); nearest(word, candidates); sourceFor(alias, ctx); knownRepo(word); formatName
// commands/legacy.ts (pure): legacyAlias, legacyOrigin, sourcedNames, removedFlagError(words, flags, argv, ctx?) /* --from --ref --alias --project; --frozen runs check in install.ts */
export function prepareArgv(argv: string[]): { args: string[]; passthrough: string[] };  // split at the first `--`
export function applyPassthrough(inv: Invocation, passthrough: string[]): Invocation;    // 0.1 `install mcp <name> -- <command> [args…]` → `--command`/`--arg` (legacy line); elsewhere E_USAGE
export class ExitSignal extends Error { exitCode: number }
// commands/program.ts
export function buildProgram(opts: { version?: string; dispatch: Dispatch; writeOut?: (text: string) => void; writeErr?: (text: string) => void }): Command; // verbs, utilities, hidden legacy commands (doctor audit outdated why find search config origin) that print the replacement and exit 2
export function parseArgv(argv: string[]): { invocation: Invocation; passthrough: string[] };
// commands/<verb>.ts: export async function run(inv: Invocation, app: App): Promise<void>
//   install.ts: source with names → installFromSource (`--as`, `--review`); no names, no --all → listSource + the "Nothing written. Install some:" block (`--grep`); bare → syncScope; mcp → mcp.ts
//     hints name the source as typed until palm.yaml declares it (engine hints of a failed install are rewritten so); a multi-name install that fails prints "Nothing installed."
//   mcp.ts: flags (`--url --header --command --arg --env --transport --cwd`) → McpServerConfig via parseAdhocMcp; `--snippet <file|->` → parseMcpJson over the file or stdin
//     (`--json` stays the global flag); secret-shaped literals through detectSecrets; then installMcp
//   check.ts: prints one line per CheckRun (status `skip` prints `-`) then problems grouped per entity and fix; `--quiet`; ExitSignal(1) when !ok; printCheck is reused by migrate.ts
//   describe.ts (+ describe-entity.ts, describe-scope.ts): `<source> <name>` reads the index for an entity not installed; a bare file name resolves to the installed path
//   migrate.ts (ExitSignal(1) on any MigrateReport.failures; then checkScope, printed, ExitSignal(1) when it fails), create.ts, get.ts, update.ts, remove.ts, init.ts (`-g`), cache.ts, completion.ts
//   The commands import core/kinds, core/source-input, domain/entity-ref and domain/ignore directly (there is no ports module) and reach the
//   engine through create/engine.ts (lazy imports). shared.ts `makeContext(app, flags)` builds the PalmContext and sets `ctx.argv` (the consent hints repeat it).
// commands/app.ts
export interface App {
  out: Output; stdin?: NodeJS.ReadableStream; program?: Command; ui?: UI; cwd?: string; env?: NodeJS.ProcessEnv; deps?: CliDeps;
  argv: string[];                                             // the command line before `--`, for hints that repeat it
  passthrough: string[];                                      // the words after `--`
  onInterrupt?: () => void;                                   // set while an install runs: the first Ctrl-C stops after the current entity
  interrupted?: boolean;                                      // the first Ctrl-C arrived while an install ran
}
// commands/adhoc.ts (was src/mcp/adhoc.ts)
export function parseAdhocMcp(name: string, opts: AdhocMcpOptions): McpServerConfig; // AdhocMcpOptions { command?; args?; url?; headers?; env?; transport?; cwd? }; E_USAGE for a missing command/url, a bad `K=V`; from: { type: 'flags' }

// ui/output.ts: the one output writer (ctx.log is this object during a command)
export interface Output extends Logger {
  jsonMode: boolean;
  readonly colors: Colors;                                    // picocolors, off for NO_COLOR and a non-TTY stdout
  configure(opts: { json?: boolean }): void;
  out(line?: string): void;                                   // data: stdout, or stderr under --json
  table(rows: string[][], header?: string[]): void;
  json(value: unknown): void;                                 // buffered; finish() writes { ...value | items: value, warnings }
  mark(mark: Mark, msg: string): void;                        // Mark = '+' | '-' | '~' | '↺' | '=' | '⊘' | 'x' | '!' | 'i'
  status(status: OutcomeStatus, line: string): void;          // the DESIGN §6 vocabulary → mark + word
  error(msg: string, hint?: string): void;                    // stderr
  hint(msg: string): void;                                    // dim follow-up line
  warn(msg: string): void;                                    // collected, printed once by finish() under "Warnings"
  warnings(): string[];
  page(text: string): Promise<void>;                          // long text (script bodies, diffs): $PAGER on a terminal, else plain
  finish(): void;
}
export function createOutput(opts?: { json?: boolean; stdout?: Sink; stderr?: Sink; isTTY?: boolean; noColor?: boolean; debug?: boolean; pager?: string }): Output;
export function outputOf(log: Logger): Output;
export function jsonEnvelope(value: unknown, warnings: string[]): Record<string, unknown>;
export function failureCount(result: object): number;       // (summary.ts, re-exported) `failures` array or outcomes with status failed/partial/modified → exit 1
export function printInstallSummary(out: Output, result: InstallResult, opts: SummaryOptions): void; // summary.ts, re-exported
//   SummaryOptions { scope; targets: TargetId[]; dryRun?: boolean /* `would …` */; first?: boolean /* the "Commit palm.yaml, palm.lock.yaml and <dirs> together." line */;
//   detected?: string[] /* where the targets were detected from, when this run wrote them */; from?: Record<string, LockSource> /* `from <source> <version>` cell */;
//   alsoCommit?: string[] /* more paths the commit line names (the source `palm create` wrote into) */; named?: boolean /* unchanged rows print; "Nothing installed." */;
//   sourceWord?: (source: string) => string /* the source as a pasteable command names it */ } (rows built in summary-rows.ts)
//   a program left out by `--all` or declined prints `! hook <name>  runs a program on your machine; not installed` with the `see it:` and `install it:` lines (DESIGN §6 step 6)
export function formatTable(rows: string[][], header?: string[], colors?: Colors): string;   // format.ts, re-exported
// ui/prompts.ts
export function createClackUI(opts?: { input?: Readable; output?: Writable }): UI; // Esc / Ctrl-C → PalmError('E_CANCELLED', 'cancelled'); consent(): prints text, reads one key (y n v d Enter); confirm(): `[y/N]` text, one key; a line (`n` + Enter) reads as its first key
export function createNonInteractiveUI(): UI;             // every prompt throws PalmError('E_NON_INTERACTIVE', ...)
// create/engine.ts: the CLI's port to the engine (lazy imports)
export interface EngineApi { openScope; installFromSource; listSource; installMcp; syncScope; removeEntities; planUpdate; applyUpdate; planChanges; reviewText; checkScope; migrateScope;
  listInstalled; describeEntity; ownerOfPath; detectTargets; requestInstallStop; resolveEngineDeps; isExecutable; parseAllowExec; parseMcpJson; enclosingProject; cleanCache;
  scopePaths(scope: Scope, root: string, palmHome: string, env: NodeJS.ProcessEnv): ScopePaths; loadManifest(file: string): Promise<Manifest> } // signatures as in the sections above
export type CliDeps = Partial<EngineDeps> & Partial<EngineApi>;                               // `CliOptions.deps`: engine collaborators plus replacements for any operation
export function engineOf(deps?: CliDeps): Engine;                                            // every EngineApi operation, returning a promise; a `deps` entry replaces the real one
// create/templates.ts (the template writer; no prompts, no editor)
export interface CreateOptions { kind: 'skill' | 'agent' | 'instruction' | 'hook'; name: string; dir?: string /* default ./agent-kit; ~/.palm/kit under -g */; description?: string; scope: Scope }
export interface CreateResult { dir: string; file: string; files: string[]; source?: SourceRef /* absent after a dry run or a failed install */; declared: boolean }
export async function createEntity(ctx: PalmContext, opts: CreateOptions, deps?: CliDeps): Promise<CreateResult>; // writes the template (E_CONFLICT when the file exists), declares the source when absent, then installFromSource
export function templateFor(kind: CreateOptions['kind'], name: string, description?: string): Array<{ rel: string; content: string; mode?: number }>;
```

## Ownership map

| Area | Directories | Owner |
|---|---|---|
| domain | `src/lib/**`, `src/domain/**`, `src/core/**` (types.ts is the contract; errors, kinds, paths, context, source-input, git, git-exec, cache, hash), `test/lib`, `test/domain`, `test/core` | domain agent |
| engine | `src/engine/**`, `test/engine` | engine agent |
| targets | `src/targets/**`, `test/targets` | targets agent |
| exec and secrets | `src/exec/**`, `src/secrets/**`, `test/exec`, `test/secrets` | exec-and-secrets agent |
| index | `src/index/**`, `test/index`, `test/fixtures/**` | index agent |
| cli | `src/cli.ts`, `src/commands/**`, `src/ui/**`, `src/create/**`, `test/cli` (except smoke) | cli agent |
| integration | `test/cli/smoke.test.ts`, `test/support/**`, `scripts/e2e.sh`, `scripts/*-baseline.json`, `knip.json`, `biome.json` import rules, README and docs regeneration, the full `npm run verify` | integration agent |

Removed directories and files: `src/mcp/**` (adhoc moves to `src/commands/adhoc.ts`, secrets to
`src/secrets/resolve.ts`, registry and serverjson are deleted), `src/core/config.ts`,
`src/core/config-file.ts`, `src/domain/origin.ts`, `src/domain/origin-set.ts`,
`src/domain/dep-ref.ts`, `src/domain/secrets.ts` (the placeholder helpers are `src/domain/secret-refs.ts`),
`src/engine/{outdated,why,find,uninstall,deploy,plan,resolve-targets}.ts`
(replaced by the modules above), `src/commands/{audit,config,doctor,find,origin,origin-marketplace,origin-view,outdated,search,why,targets,ports}.ts`,
`src/create/{agent,command,instruction,skill,shared}.ts`, `src/targets/{convert-command,planners,plan,recorded,shared-skills}.ts`.

Each agent keeps its own tests green with fakes for what it consumes (`test/support/fakes.ts`
gains `fakeTarget` implementing `render`/`apply`/`undeploy`, `fakeExec` and `fakeSecrets`;
the domain agent updates the fakes file, the others extend it only under their own names).
Contract changes go into `src/core/types.ts`, `DESIGN.md` and this file together.
