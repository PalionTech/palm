/**
 * palm: shared type contract (v3, palm 0.2). See DESIGN.md and API.md.
 *
 * Every module imports its types from here. Extend this file (and DESIGN.md) rather than
 * inventing private shapes. This file imports nothing from the rest of palm.
 */

// ---------------------------------------------------------------------------
// Kinds, targets, scopes
// ---------------------------------------------------------------------------

/**
 * Entity kinds. `command` is gone: command files in a source are indexed as skills
 * (`SkillDefinition.fromCommand`). `plugin` is a kind in the index and the lock (members carry
 * `via: plugin:<name>`), but the CLI presents it as a selector over a source's entities.
 */
export type Kind = 'skill' | 'agent' | 'instruction' | 'hook' | 'mcp' | 'plugin';

export const KINDS: readonly Kind[] = [
  'skill',
  'agent',
  'instruction',
  'hook',
  'mcp',
  'plugin',
] as const;

/** Kinds a user can name on the command line and in palm.yaml (`plugin` selects, the rest install). @public */
export type ManifestKind = Kind;

export type TargetId = 'claude' | 'codex' | 'copilot' | 'cursor' | 'gemini' | 'opencode';

/** Every target, in detection order. */
export const TARGET_IDS: readonly TargetId[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'opencode',
] as const;

export type Scope = 'project' | 'global';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Optional override of layout auto-detection for one source. Globs are relative to the source root. */
export interface LayoutDescriptor {
  /** Globs matching directories that contain SKILL.md. */
  skills?: string | string[];
  /** Globs matching agent definition files. */
  agents?: string | string[];
  /** Globs matching command/prompt files (indexed as skills). */
  commands?: string | string[];
  /** Globs matching instruction/rule files. */
  instructions?: string | string[];
  /** Globs matching hooks.json files. */
  hooks?: string | string[];
  /** Globs matching MCP config files (.mcp.json / mcp.json). */
  mcp?: string | string[];
  /** Globs to exclude from every scan. */
  exclude?: string[];
  /** Restrict the index to these canonical names. */
  include?: string[];
  /** How a skill's canonical name is derived. Default: frontmatter. */
  nameFrom?: 'frontmatter' | 'dirname';
}

/** @public How a source is fetched: a git repository, or a directory read in place. */
export type SourceType = 'git' | 'local';

/**
 * A place entities come from, declared in the manifest of its scope (`sources:` in palm.yaml,
 * or in `~/.palm/palm.yaml` under `-g`). The `name` is the manifest key: `owner/repo` for a
 * GitHub repository, `./dir` for a directory inside the project, otherwise a chosen name with
 * `url:` or `path:`. Names and aliases are unique within one manifest, case-insensitively.
 */
export interface Source {
  name: string;
  type: SourceType;
  /** git: normalized clone URL (https://github.com/owner/repo.git or ssh form). */
  url?: string;
  /** local: directory path. Project scope stores it project-relative; in memory it is absolute. */
  path?: string;
  /** git: version intent, the one home of it: a tag, branch, sha or semver range (`^1.2`). */
  ref?: string;
  /** Subdirectory inside the repository that is the real source root. */
  root?: string;
  /** Optional short name accepted wherever the name is (`palm get -s mp`). Must match ALIAS_RE. */
  alias?: string;
  layout?: LayoutDescriptor;
}

/** Result of fetching a source into the cache (git) or resolving it in place (local). */
export interface SourceCheckout {
  source: Source;
  /** Cache dir name; see DESIGN.md section 5. Never the source name. */
  sourceId: string;
  /** Absolute path to the directory that should be scanned (repo root + source.root). */
  root: string;
  /** Absolute path to the repository checkout (before `root` is applied); local: the directory itself. */
  repoDir: string;
  /** Resolved commit sha (git) or undefined (local). */
  sha?: string;
  /** The ref that was actually checked out (tag/branch name or sha). */
  ref?: string;
  /** Local sources: the source tree hash (DESIGN.md section 4, `tree`). */
  tree?: string;
}

// ---------------------------------------------------------------------------
// Entities (what the index contains)
// ---------------------------------------------------------------------------

export interface EntityRef {
  kind: Kind;
  name: string;
}

/** A user-typed entity reference: `[kind:]name`. */
export interface EntityRefSpec {
  kind?: Kind;
  name: string;
}

/** Canonical, harness-neutral MCP server definition. */
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Secrets referenced by env/headers that the user must supply. */
  secrets?: SecretRef[];
  /** Where this config came from, for display: a source (its name and version), palm.yaml, a README snippet or flags. */
  from?: { type: 'source' | 'palm.yaml' | 'snippet' | 'flags'; ref?: string; version?: string };
}

export interface SecretRef {
  /** Environment variable name (also used as placeholder name). */
  name: string;
  /** Where it is used. */
  in: 'env' | 'header' | 'arg' | 'url';
  /** Header name when `in === 'header'`. */
  header?: string;
  description?: string;
  required: boolean;
  /** Value template for headers, e.g. "Bearer {value}". */
  format?: string;
}

/** Canonical agent definition = Claude Code frontmatter superset + body. */
export interface AgentDefinition {
  name: string;
  displayName?: string;
  description: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  /** Skill names the agent mentions. palm does not install them; it prints one hint line. */
  skills?: string[];
  /** MCP server names the agent mentions. Same rule as `skills`. */
  mcpServers?: string[];
  color?: string;
  /** The system prompt (markdown body). */
  body: string;
  /** Unmapped frontmatter keys, passed through to targets that understand them. */
  extra?: Record<string, unknown>;
  /** Format the source file was in. */
  sourceFormat?: 'claude-md' | 'copilot-agent-md' | 'codex-toml' | 'cursor-md' | 'apm-agent-md';
}

/**
 * How an instruction is activated by the harness that authored it (DESIGN.md section 2).
 * Written by the index from the source format; targets preserve or map it (0.3), never widen.
 */
export type Activation = 'always' | 'on-request' | 'paths' | 'manual';

export interface InstructionDefinition {
  name: string;
  description?: string;
  /** Path globs the instruction applies to; empty/undefined = always. */
  globs?: string[];
  alwaysApply: boolean;
  activation: Activation;
  body: string;
  /**
   * `claude-md`: a `.md` rule Claude Code reads as it is (no `globs`, `applyTo` or `alwaysApply`
   * frontmatter); installed for claude byte-identical, under its own file name (ruling B12).
   */
  sourceFormat?: 'md' | 'claude-md' | 'mdc' | 'instructions-md' | 'agents-md';
  /** The source file name when a verbatim copy keeps it and it differs from `<name>.md`. */
  fileName?: string;
}

/** A command file the index turned into a skill: the target renders SKILL.md from these. */
export interface CommandAsSkill {
  body: string;
  argumentHint?: string;
  sourceFormat: 'claude-md' | 'prompt-md' | 'gemini-toml' | 'opencode-md';
}

export interface SkillDefinition {
  name: string;
  description: string;
  version?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  /** Directory name if it differs from `name`. */
  dirName?: string;
  /** Parent skill name for nested sub-skills. */
  parent?: string;
  /** Present when the entity was a command file: `path` is that file, not a directory. */
  fromCommand?: CommandAsSkill;
  extra?: Record<string, unknown>;
}

export type HookDialect = 'claude' | 'cursor' | 'copilot' | 'gemini' | 'unknown';

/** Where a plugin-root or relative reference was found in a hook or MCP definition. */
export type ReferenceSite = 'command' | 'args' | 'cwd';

/**
 * One reference to a file of the source, found at index time (DESIGN.md section 2,
 * "Relocation"). `rel` is the source-relative path it names; an unresolvable reference has
 * `unresolved` set and refuses the entity at install.
 */
export interface SourceReference {
  /** The text as written (`${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`, `./scripts/y.sh`). */
  raw: string;
  /** `unresolvable`: `eval`, `$(…)`, backticks, `~/` or `$HOME/`, which name nothing in the source. */
  form: 'plugin-root' | 'relative' | 'project-dir' | 'unresolvable';
  site: ReferenceSite;
  /** Source-relative path of what it names, when it resolved. */
  rel?: string;
  /** The reason it did not resolve (the offending line is `raw`). */
  unresolved?: string;
}

/** What install copies for an entity's executables: source-relative paths (files or directories). */
export interface Closure {
  /** Directories and files, source-relative, sorted, no duplicates, never a skill, root doc or manifest. */
  paths: string[];
  /**
   * The part of `paths` a closure script reads rather than runs (ruling E1, found by
   * `src/exec/reads.ts`): copied even when CLOSURE_NEVER names it (a hook that reads a
   * SKILL.md), and listed at consent as `reads:`.
   */
  reads?: string[];
}

export interface HookSet {
  name: string;
  dialect: HookDialect;
  /** Parsed JSON of the hooks file (or the inline manifest block). */
  raw: unknown;
  /** Directory (relative to source root) that `${CLAUDE_PLUGIN_ROOT}` / `${CURSOR_PLUGIN_ROOT}` refer to. */
  pluginRootRel?: string;
  /** Every plugin-root or relative reference in its commands, resolved at index time. */
  references: SourceReference[];
  /** What a deploy copies to the asset directory (empty for prompt-only hook sets). */
  closure: Closure;
  /** Commands with `type: prompt`, listed at consent as text, never gated. */
  promptHooks: Array<{ event: string; matcher?: string }>;
}

export interface Entity {
  kind: Kind;
  /** Canonical id: slug for skills/agents/plugins, server key for mcp. */
  name: string;
  description?: string;
  version?: string;
  /**
   * Location relative to the source root:
   * skill/plugin → directory (a command-as-skill → the file); agent/instruction/hook → file; mcp → the config file.
   */
  path: string;
  /** Source name. */
  source: string;
  /** Containing plugin name, when the entity was found through a plugin manifest. */
  plugin?: string;
  /** Kind-specific parsed definition. */
  def:
    | { kind: 'skill'; skill: SkillDefinition }
    | { kind: 'agent'; agent: AgentDefinition }
    | { kind: 'instruction'; instruction: InstructionDefinition }
    | { kind: 'hook'; hooks: HookSet }
    | { kind: 'mcp'; mcp: McpServerConfig; references: SourceReference[]; closure: Closure }
    | { kind: 'plugin'; members: EntityRef[]; manifestPath?: string };
  /** Problems found in the entity's files during the scan; absent when none. */
  issues?: EntityIssue[];
  /** Index notes shown at install and by `describe` (`from command review.md`). */
  notes?: string[];
}

/** A problem the scanner found in one of an entity's files (DESIGN.md section 5, "Scan issues"). */
export interface EntityIssue {
  /** `hidden-unicode` | `unresolvable-reference` | `secret-literal` | `oversized`. */
  code: 'hidden-unicode' | 'unresolvable-reference' | 'secret-literal' | 'oversized';
  severity: 'critical' | 'warning';
  /** One line naming the file and what was found. */
  message: string;
  /** Source-relative file the issue is in. */
  file?: string;
}

export interface ScanResult {
  entities: Entity[];
  /** Human-readable notes: remote marketplace entries not fetched, name mismatches, skipped files. */
  warnings: string[];
  /** Which detection rule fired (recorded in the lock as `descriptor`). */
  detected: 'descriptor' | 'apm' | 'marketplace' | 'plugin-manifest' | 'convention' | 'empty';
}

export interface SourceIndex extends ScanResult {
  source: string;
  sourceId: string;
  sha?: string;
  ref?: string;
  tree?: string;
  root: string;
}

// ---------------------------------------------------------------------------
// Manifest (palm.yaml, v3)
// ---------------------------------------------------------------------------

/**
 * One entry under a source's kind list. A string is the name; the object form narrows it.
 * `only`/`exclude` apply to plugins and list members as `kind:name`. `at` is stored in 0.2 and
 * honoured in 0.3 (placement root). `render` is reserved (0.3: `verbatim`, `stripHiddenUnicode`).
 */
export interface ManifestEntryObject {
  name: string;
  targets?: TargetId[];
  at?: string;
  only?: string[];
  exclude?: string[];
  render?: Record<string, unknown>;
  /** `--secrets literal` recorded for the entry, so a bare install keeps the policy (Y19). */
  secrets?: 'literal';
}

export type ManifestEntry = string | ManifestEntryObject;

/** A source as written in palm.yaml, with the entries installed from it. */
export interface ManifestSource {
  url?: string;
  path?: string;
  root?: string;
  ref?: string;
  alias?: string;
  layout?: LayoutDescriptor;
  skills?: ManifestEntry[];
  agents?: ManifestEntry[];
  instructions?: ManifestEntry[];
  hooks?: ManifestEntry[];
  mcp?: ManifestEntry[];
  plugins?: ManifestEntry[];
}

/** A hand-declared MCP server inside palm.yaml (`mcp:` map, keyed by the config name). */
export interface McpManifestEntry {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  targets?: TargetId[];
  /** `--secrets literal` recorded for the server, so a bare install keeps the policy (Y19). */
  secrets?: 'literal';
}

export interface Manifest {
  targets?: TargetId[];
  sources?: Record<string, ManifestSource>;
  mcp?: Record<string, McpManifestEntry>;
  /**
   * Warnings someone reviewed and acknowledged (O19 J13'): `hidden-unicode:<source>/<path>`,
   * `foreign-hooks:<file>#<event>`, `foreign-servers:<file>#<name>`. `check` stops repeating them.
   */
  ignore?: string[];
}

/** palm.local.yaml (0.3): the same shape plus `disable`. Reserved; not read in 0.2. @public */
export interface LocalManifest extends Manifest {
  disable?: string[];
}

// ---------------------------------------------------------------------------
// Lockfile (palm.lock.yaml, v3)
// ---------------------------------------------------------------------------

export interface LockSource {
  /** git: clone URL. */
  url?: string;
  root?: string;
  /** git: the ref intent copied from the manifest when resolved. */
  ref?: string;
  /** git: the resolved commit. */
  sha?: string;
  /** git: the tag or branch the sha was resolved from, when `ref` is a range. */
  resolved?: string;
  /** local: project-relative path (project scope) or `<home>`-token path (global). */
  path?: string;
  /** local: source tree hash at the last render (DESIGN.md section 4). */
  tree?: string;
  /** The layout in effect, so another machine rebuilds the index from the sha alone. */
  layout?: LayoutDescriptor;
  /** Which scan rule produced the index. */
  descriptor?: ScanResult['detected'];
}

/**
 * A fragment palm merged into a shared file, without its value (the render yields it).
 * `id` is palm's identity (`palm:<kind>:<name>:<n>`); `key` is what finds the fragment inside
 * `at` on disk: the object key or TOML table name for keyed fragments, the block id for
 * markdown blocks, and for appended array items the `sha256:<8 hex>` of the item's identity
 * fields (hooks: matcher and command strings; OpenCode instructions: the string).
 */
export interface LockMerged {
  /** Lock-form path of the shared file. */
  file: string;
  /** JSON pointer to the array or object, `/mcp_servers/<n>` for TOML, `block:<id>` for markdown. */
  at: string;
  id: string;
  key: string;
  /**
   * palm created the shared file when it merged this fragment (`ApplyResult.merged` sets it; the
   * lock keeps it while the fragment stays). Undeploy deletes such a file when only the keys palm
   * ensured are left (Cursor's `{"version": 1}`, ruling J14); a file the person had stays.
   */
  created?: boolean;
}

/** The executables of one hook entry or stdio MCP server, as the lock records them. */
export interface LockExec {
  /** One line per harness-run command: `<Event>//<matcher or ->[#n]` (Claude event names) for hooks, `stdio` for MCP. */
  commands: Array<{ id: string; command: string }>;
  /** Asset directory (lock form), or the in-repo source for an in-place closure, and the closure tree hash. */
  closure?: { root: string; files: number; tree: string };
  /** The exec hash (DESIGN.md section 7): sha256 over the canonical commands and the closure tree. */
  hash: string;
}

export interface LockEntry {
  kind: Kind;
  name: string;
  source: string;
  /** Source-relative path of the entity. */
  path: string;
  /** `plugin:<name>` when installed as a plugin member. */
  via?: string;
  /** sha256 of the entity's source content. */
  content: string;
  /** One render hash per target the entry is on (DESIGN.md section 4). */
  render: Partial<Record<TargetId, string>>;
  /** Every path palm wrote for this entry, lock form, sorted. Directories are listed by their files. */
  files: string[];
  merged?: LockMerged[];
  exec?: LockExec;
  /** Exec hashes a person consented to; replayed silently while `exec.hash` is among them. */
  trust?: string[];
  /** Persistent notes (dropped fields, skipped targets, mapped activation). */
  notes?: string[];
  /** Only when the entry is narrowed below the scope's target set. */
  targets?: TargetId[];
  /** Placement root (0.3, `at:`). Stored when the manifest sets it; ignored by 0.2 targets. */
  at?: string;
  /** Plugin entries only: the members it declared. */
  deps?: EntityRef[];
  /** 0.3: the carrier file per target when one file carries the entity for several harnesses. */
  carrier?: Partial<Record<TargetId, string>>;
}

export interface Lockfile {
  version: 3;
  sources: Record<string, LockSource>;
  entries: LockEntry[];
}

/**
 * `$PALM_HOME/applied.yaml`: what this machine holds for the global scope, the only machine
 * record palm keeps. Project scope has none (git carries the outputs).
 */
export interface AppliedRecord {
  /** sha256 of the lock bytes last applied. */
  lockHash: string;
  /** Absolute paths, one per file palm wrote, with the hash of what it wrote. */
  files: Array<{ path: string; hash: string }>;
  /** Merged fragments with absolute file paths. */
  merged: Array<LockMerged & { entry: string }>;
  /** The harness homes the tokens expanded to. */
  homes: Partial<Record<TargetId | 'home' | 'palm' | 'agents', string>>;
}

// ---------------------------------------------------------------------------
// Legacy formats (read only by `palm migrate`)
// ---------------------------------------------------------------------------

export interface LegacyOriginSpec {
  alias: string;
  type: 'git' | 'local';
  url?: string;
  path?: string;
  ref?: string;
  root?: string;
  layout?: LayoutDescriptor;
}

export interface LegacyManifest {
  targets?: TargetId[];
  origins?: Array<string | LegacyOriginSpec>;
  skills?: unknown[];
  agents?: unknown[];
  instructions?: unknown[];
  commands?: unknown[];
  hooks?: unknown[];
  mcp?: unknown[];
  plugins?: unknown[];
}

export interface LegacyLockEntry {
  kind: string;
  name: string;
  origin: string;
  url?: string;
  root?: string;
  ref?: string;
  sha?: string;
  path: string;
  contentHash?: string;
  targets?: TargetId[];
  files?: Array<string | { path: string; hash: string }>;
  merged?: Array<{ file: string; pointer: string; value: unknown }>;
  via?: string;
  deps?: EntityRef[];
}

export interface LegacyLockfile {
  version: 1 | 2;
  targets?: TargetId[];
  createdDirs?: string[];
  entries: LegacyLockEntry[];
}

export interface LegacyConfig {
  targets?: TargetId[];
  origins?: LegacyOriginSpec[];
  secrets?: { project?: SecretPolicy; global?: SecretPolicy };
}

// ---------------------------------------------------------------------------
// Executable content and consent (src/exec)
// ---------------------------------------------------------------------------

export interface ClosureFile {
  /** Path relative to the closure root. */
  path: string;
  /** Permission bits (0o755 / 0o644). */
  mode: number;
  /** Bytes, for the consent prompt's sizes. */
  size: number;
  hash: string;
}

/**
 * One unit of executable material: a hook entry (every command it merges, in every target) or
 * a stdio MCP server. `hash` = sha256(canonical commands ‖ events ‖ matchers ‖ env keys ‖ cwd ‖
 * closure tree); in-repo sources hash their scripts too, read in place (ruling E2).
 * `canonical` keeps placeholders, so a new target or a palm upgrade never moves the hash.
 */
export interface ExecUnit {
  kind: 'hook' | 'mcp';
  entity: { kind: Kind; name: string; source: string };
  /** `hook:<name>@<source>` or `mcp:<name>@<source>`: the `--allow-exec` key. */
  key: string;
  commands: Array<{ id: string; canonical: string; event?: string; matcher?: string }>;
  /**
   * Closure root (lock form) and files. In-place (in-repo) closures list their files as they
   * are in the working tree, and `abs` names the directory they are read from (`v`).
   */
  closure: { root: string; inPlace: boolean; files: ClosureFile[]; bytes: number; abs?: string };
  /** Closure files a script reads rather than runs (ruling E1), listed at consent as `reads:`. */
  reads?: string[];
  /**
   * Findings the consent review shows under the unit as `!` rows, such as a literal secret in a
   * script installed with `--force` (ruling 28). The engine fills it; it never changes the hash.
   */
  warnings?: string[];
  hash: string;
  /** Per target: the rendered command line and the file it lands in (for the prompt). */
  rendered: Partial<Record<TargetId, Array<{ id: string; command: string; file: string }>>>;
  /** X16: targets the program is not installed for, with the reason (never part of the hash). */
  skipped?: Partial<Record<TargetId, string>>;
  /** Commit and ref the unit comes from, for the prompt header. */
  from?: { sha?: string; ref?: string; date?: string };
  /** MCP only: environment keys and cwd, part of the identity. */
  env?: string[];
  cwd?: string;
}

/** `--allow-exec` as parsed: `hook:gh-cli@trailofbits/skills=sha256:<64 hex>` (the hash may be a prefix of at least 16 hex). */
export interface AllowExec {
  key: string;
  hash: string;
}

export type ConsentAnswer = 'yes' | 'no' | 'view' | 'diff';

/** Reads one closure file's body at the unit's pinned commit, for `v` and `d`; undefined when unavailable. */
export type ScriptReader = (unit: ExecUnit, file: ClosureFile) => Promise<string | undefined>;

export interface ConsentRequest {
  /** The prompt header: `This install adds …` or `This update adds …`. */
  operation: 'install' | 'update';
  /** The units that need consent now (new or changed hash). */
  units: ExecUnit[];
  /** Prompt hooks listed as text. */
  prompts: Array<{ entity: string; event: string; matcher?: string }>;
  /** On update: the previously trusted unit per key, for the diff. */
  previous?: Record<string, ExecUnit>;
  /** Where the hashes will be recorded. */
  lockFile: string;
  /** Where `v` and `d` read script bodies (the engine knows the checkouts). */
  read?: ScriptReader;
}

export interface ConsentOutcome {
  /** Keys the user allowed (or that `--allow-exec` matched). */
  allowed: string[];
  /** Keys declined. */
  declined: string[];
}

// ---------------------------------------------------------------------------
// Secrets (src/secrets)
// ---------------------------------------------------------------------------

export type SecretPolicy = 'env-ref' | 'literal';

export type SecretShape =
  | 'prefix'
  | 'bearer'
  | 'private-key'
  | 'high-entropy'
  | 'url-userinfo'
  | 'url-token';

export interface SecretFinding {
  /** What was scanned: `mcp:<name>.env.KEY`, `hook:<name>#<id>`, `.palm/assets/x/y.sh:12`, `palm.yaml:mcp.docs.headers.Authorization`. */
  where: string;
  shape: SecretShape;
  /** `<redacted sha256:8>`; never the value. */
  redacted: string;
  /** The key or header name when known. */
  key?: string;
}

/** Why a literal may or may not be written to one destination. */
export interface SecretDecision {
  policy: SecretPolicy;
  /** `refused` never writes; `warn` writes and reports. */
  action: 'env-ref' | 'literal' | 'refused' | 'warn';
  reason: string;
}

// ---------------------------------------------------------------------------
// Context passed through every operation
// ---------------------------------------------------------------------------

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  success(msg: string): void;
}

export interface PickOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Interaction surface. CLI implements with @clack/prompts; tests with fakes. */
export interface UI {
  isInteractive: boolean;
  pick<T>(message: string, options: PickOption<T>[]): Promise<T>;
  pickMany<T>(message: string, options: PickOption<T>[], initial?: T[]): Promise<T[]>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  text(
    message: string,
    opts?: { placeholder?: string; initial?: string; validate?: (v: string) => string | undefined },
  ): Promise<string>;
  secret(message: string): Promise<string>;
  /**
   * The consent prompt (DESIGN.md section 7): `text` is printed, then one key is read:
   * `y` yes, `n` or Enter no, `v` view scripts, `d` diff (only when `canDiff`). Non-interactive
   * implementations throw E_NON_INTERACTIVE.
   */
  consent(text: string, opts: { canDiff: boolean }): Promise<ConsentAnswer>;
  spinner(message: string): { stop(msg?: string): void; message(msg: string): void };
}

export interface PalmPaths {
  /** $PALM_HOME or ~/.palm */
  palmHome: string;
  /** User home (respecting HOME override in tests). */
  home: string;
  /** Project root for project scope (see DESIGN.md section 2). */
  projectRoot: string;
  cwd: string;
}

export interface PalmFlags {
  /** Accept defaults for non-consent prompts. Never consents to executables. */
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  offline: boolean;
  json: boolean;
  /** Parsed `--allow-exec`; `'all'` is accepted only on a terminal. */
  allowExec: AllowExec[] | 'all';
  /** `--secrets literal` (project scope needs it for typed literals). */
  secrets?: SecretPolicy;
  /** 0.3: write to palm.local.yaml. Parsed and refused with E_USAGE in 0.2. */
  local: boolean;
  /** `--review` on install and update: script bodies before the consent question. */
  review?: boolean;
  /**
   * S4': `--allow-local-sources` on install, update, remove and check: palm.yaml may name a
   * `file://` source outside the project (a clone with local mirrors, CI on an air-gapped host).
   */
  allowLocalSources?: boolean;
}

export interface PalmContext {
  paths: PalmPaths;
  ui: UI;
  log: Logger;
  env: NodeJS.ProcessEnv;
  flags: PalmFlags;
  /** The command line after `palm`, as typed; the consent error repeats it in its hint lines. */
  argv?: readonly string[];
}

// ---------------------------------------------------------------------------
// Engine requests and results
// ---------------------------------------------------------------------------

/** `palm install <source> [names…] [--all]`, one request per source. */
export interface InstallRequest {
  /** A declared source name or alias, or CLI input (`owner/repo[#ref]`, URL, path) declared on first use. */
  source: string;
  /** Entity references; empty with `all` = every installable entity of the source. */
  names: EntityRefSpec[];
  all?: boolean;
  /** Per-entry narrowing written to palm.yaml. */
  targets?: TargetId[];
  at?: string;
  /** `--as <name>`: the name a newly declared source gets in palm.yaml. */
  as?: string;
  /**
   * `--layout kind=glob` (repeatable), parsed by `parseLayoutFlags` (src/index/layout-flags.ts):
   * the `layout:` a newly declared source gets in palm.yaml (ruling K2).
   */
  layout?: LayoutDescriptor;
}

/** A hand-declared MCP server (`install mcp` flags, `--json` snippet) headed for `mcp:` in palm.yaml. */
export interface McpRequest {
  config: McpServerConfig;
  targets?: TargetId[];
}

export interface InstallOptions {
  scope: Scope;
  /** 0.3: record in palm.local.yaml. Refused in 0.2. */
  local?: boolean;
}

export type OutcomeStatus =
  | 'installed'
  | 'updated'
  | 're-rendered'
  | 'restored'
  | 'unchanged'
  | 'modified'
  | 'partial'
  | 'skipped'
  | 'removed'
  | 'failed';

export interface InstallOutcome {
  entry: LockEntry;
  status: OutcomeStatus;
  /** Per target when the status differs by target (`partial`). */
  perTarget?: Partial<Record<TargetId, OutcomeStatus>>;
  notes: string[];
  /**
   * A program this run did not install: declined at the consent prompt or left out by `--all`.
   * A plugin's member is then recorded as `exclude: [kind:name]` on the plugin entry (D28).
   */
  declined?: true;
  /** S8: the program hash this run's consent trusted (`~ trusted hook x sha256:…`). */
  trusted?: string;
}

/** One thing a run could not do. The run continues; the CLI exits 1 when any exist. */
export interface InstallFailure {
  /** The entity's kind, or `source` when a source could not be fetched. */
  kind: Kind | 'source';
  name: string;
  source: string;
  /** The target that failed, when the failure is one target's. */
  target?: TargetId;
  /** A PalmError code. */
  code: string;
  message: string;
  hint?: string;
}

export interface InstallResult {
  outcomes: InstallOutcome[];
  warnings: string[];
  /** Per-entity/target failures (never thrown): the lock records only what succeeded. */
  failures: InstallFailure[];
  /**
   * Set when a stop request (the first Ctrl-C) ended the run after `done` of `total` entities;
   * the lock records those, and the CLI exits 130 after printing the result (K16, L11).
   */
  interrupted?: { done: number; total: number };
  /**
   * The files (and `file#at#key` fragments) this run removed, or would remove in a dry run, as
   * people read them (`~/…` under -g): what `--json` shows (J10'), including the files of a
   * target palm.yaml no longer lists (B2).
   */
  removals?: string[];
  /**
   * Install with names: what the typed names resolved to, each with its kind, after any
   * which-kind question (O4, Q4). A plugin's member the person declined is not among them, so
   * declining it is no named decline.
   */
  requested?: EntityRef[];
}

/** A file `remove` left on disk, and why (C3, K18, R5). */
export interface KeptFile {
  kind: Kind;
  name: string;
  source: string;
  /** Lock form. */
  file: string;
  /** `owned`: another entry lists it (`owner` names it); `source`: it lies inside a declared source. */
  reason: 'owned' | 'source';
  /** `kind name from source` of the entry that still owns the file. */
  owner?: string;
}

export interface RemoveResult {
  removed: LockEntry[];
  failures: InstallFailure[];
  warnings: string[];
  /** Files of removed entries that stayed on disk (another owner, or inside a source). */
  kept?: KeptFile[];
}

export type UpdateMark = 'updated' | 'added' | 'removed' | 'unchanged' | 'failed' | 'skipped';

export interface UpdatePlanItem {
  mark: UpdateMark;
  kind: Kind;
  name: string;
  source: string;
  via?: string;
  /** `v1.0.0 (abc1234)` or `content <hash7>`. */
  from?: string;
  to?: string;
  /** Lock paths the user changed since palm wrote them (kept unless --force). */
  atRisk: string[];
  /** The exec unit after the update, when it is new or its hash changed. */
  exec?: { unit: ExecUnit; previous?: ExecUnit };
  note?: string;
}

/** One source row of an update plan. */
export interface UpdatePlanSource {
  name: string;
  from?: string;
  to?: string;
  ref: string;
  /** The newest release tag, when the ref is a tag or sha pin below it (D4, C19). */
  latest?: string;
  /** The default branch and its head, for a tag or sha pin (`93f5a2d; main is 063bee9`, C19). */
  head?: { branch: string; sha: string };
  /** Why the source counts as a change with no entry changing (`--strict`, D11). */
  reason?: string;
}

export interface UpdatePlan {
  scope: Scope;
  sources: UpdatePlanSource[];
  items: UpdatePlanItem[];
  failures: InstallFailure[];
  warnings: string[];
  /** Programs a source ships that nothing installs (new since the locked commit), V7. */
  available?: Array<{ kind: Kind; name: string; source: string; command: string }>;
}

/** `skipped`: the check did not run (outside a repository, an empty cache offline); never shown as passed. */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface CheckProblem {
  entity?: { kind: Kind; name: string; source: string };
  file?: string;
  message: string;
  /** The command that fixes it. */
  fix?: string;
}

export interface CheckRun {
  /** Stable id: `manifest-lock`, `render`, `partial`, `lock-disk`, `orphans`, `pending`, `local-sources`, `source-paths`, `exec-trusted`, `foreign-hooks`, `hook-scripts`, `secrets`, `git-ignored`, `sources-declared`, `links`, `hidden-unicode`, `double-load`, `agent-names`, `preloads`, `block-size` (FINDINGS-v2 ruling 29 added `render` through `preloads`). */
  id: string;
  label: string;
  status: CheckStatus;
  problems: CheckProblem[];
}

export interface CheckReport {
  scope: Scope;
  checks: CheckRun[];
  /** True when no check failed. */
  ok: boolean;
}

export interface MigrateReport {
  manifest: string;
  lock: string;
  sourcesAdded: string[];
  movedAssets: string[];
  gitignore?: string;
  /** Executables re-vendored, for the one consent. */
  exec: ExecUnit[];
  warnings: string[];
  /**
   * What could not be migrated; the CLI exits 1 when any exist. The CLI then runs `palm check`
   * on the migrated scope and fails the migration when the check fails.
   */
  failures: InstallFailure[];
  /**
   * Project scope in a git repository: every path the migration changed or created, as
   * `git status` lists it (untracked output folders as `dir/`), to commit together.
   */
  commit?: string[];
  /**
   * X8 B7 J5' Y4': every file the migration deleted (in a dry run: would delete), in path
   * order, with why. Printed one line each: `- removed <file>: <reason>` (`- would remove` in a
   * dry run).
   */
  removed?: MigrateRemoval[];
  /**
   * N15 M11: in a dry run, the files the install would write or change (as people type them), in
   * path order. Printed one line each: `~ would write <file>`.
   */
  written?: string[];
  /**
   * X8: the notes palm 0.2 keeps on the migrated entries (a harness skipped, a variable a server
   * needs), one line each as `<kind> <name>: <note>`. Printed with `i`.
   */
  notes?: string[];
  /** V5': fragments palm 0.1 wrote that someone changed since, and what palm did with each. */
  changed?: MigrateChanged[];
}

/** A file `palm migrate` deleted (or, in a dry run, would delete). */
export interface MigrateRemoval {
  /** Project-relative, or `~/…` under -g. */
  file: string;
  /** Why, in plain words: `palm 0.1 copied it; palm 0.2 writes agents/openai.yaml only into .agents/skills`. */
  reason: string;
}

/**
 * V5': a fragment palm 0.1 wrote (a hook command, a server block) that differs from what 0.1
 * recorded. `replaced`: the person agreed (or `--force`), palm 0.2's render replaced it;
 * `kept`: the person declined, it stays as they changed it (check reports it as foreign);
 * `ask`: a dry run, nothing decided. Printed `! <kind> <name>: <file> (<at>) changed since palm
 * 0.1 wrote it; <replaced with palm 0.2's render | kept as you changed it | palm migrate asks>`.
 */
export interface MigrateChanged {
  kind: Kind;
  name: string;
  /** Project-relative, or `~/…` under -g. */
  file: string;
  /** The JSON pointer or block the fragment sits at (`/hooks/Stop`). */
  at: string;
  action: 'replaced' | 'kept' | 'ask';
}

// ---------------------------------------------------------------------------
// Target interface (src/targets/*)
// ---------------------------------------------------------------------------

/** Everything a target needs to render one entity. Pure apart from reading the source. */
export interface RenderInput {
  entity: Entity;
  /** Absolute path of the entity on disk (dir for skill/plugin, file otherwise). */
  absPath: string;
  /** Absolute source root (for resolving references and the closure). */
  sourceRoot: string;
  source: Source;
  scope: Scope;
  /** Absolute directory that lock-form paths resolve against (projectRoot or home). */
  scopeRoot: string;
  /** Lock-form directory that holds this entity's closure: `.palm/assets/<source>/<entity>` (git) or the source path itself (local, `inPlace`). */
  assetsRoot: string;
  inPlace: boolean;
  secretPolicy: SecretPolicy;
  /** Resolved secret values when the policy is literal. */
  secretValues?: Record<string, string>;
  /** Environment for CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / PALM_HOME resolution (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** The targets active for the entry (cursor writes `.claude/skills` when claude is active). */
  targets?: readonly TargetId[];
  /** `--force`: a skill above the copy limits (200 files or 5 MB) is copied anyway (ruling Y2). */
  force?: boolean;
}

export interface RenderedFile {
  /** Lock-form path. */
  path: string;
  data: Uint8Array;
  /** Permission bits; undefined = default. */
  mode?: number;
}

/** A fragment to merge into a shared file, with its value; the lock stores it without the value. */
export interface RenderedFragment extends LockMerged {
  value: unknown;
  /** Create the shared file 0600 when it does not exist (user-level secret-bearing files). */
  createMode?: number;
  /** Set on the shared file even when it exists (it now holds a literal secret). */
  mode?: number;
  /** Top-level keys the file needs (Cursor's `version: 1`): set when missing, never recorded. */
  ensure?: Record<string, unknown>;
}

export interface Rendered {
  files: RenderedFile[];
  fragments: RenderedFragment[];
  /** The exec commands this target will run, canonical and rendered, for the exec unit. */
  exec: Array<{
    id: string;
    canonical: string;
    command: string;
    file: string;
    event?: string;
    matcher?: string;
  }>;
  notes: string[];
  /** True when the target has nothing to do for this kind/scope (documented gap; noted). */
  skipped?: boolean;
  /** sha256 over the sorted (path, mode, content hash) list plus fragment (file, at, key, canonical JSON value) list. */
  hash: string;
}

/** Files already owned by the entity being written (so they may be replaced). */
export interface ApplyInput {
  rendered: Rendered;
  scopeRoot: string;
  /** Lock-form files and `file#at#key` fragments the previous lock entry owns. */
  owned: string[];
  force: boolean;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  /** The scope the render is for (global renders check every boundary). */
  scope?: Scope;
}

export interface ApplyResult {
  /** Every lock-form path the render lists (written, adopted, or that would be in a dry run). */
  files: string[];
  /** The render's fragments; `created` on those whose shared file this apply created (J14). */
  merged: LockMerged[];
  /** The subset of `files` present with identical content, adopted without writing. */
  adopted: string[];
  notes: string[];
}

export interface Target {
  id: TargetId;
  displayName: string;
  /** True when the harness appears to be in use at this scope. */
  detect(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<boolean>;
  /**
   * The absolute path that made `detect` true (`<root>/.codex`, `<root>/CLAUDE.md`), for the
   * evidence `init` prints (`codex (.codex)`); undefined when the harness is not detected.
   * An `AGENTS.md` alone never marks Codex (ruling Y15).
   */
  evidence?(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  /**
   * Agent files in this harness's agents directory that answer to one name (lock-form paths),
   * for `check` to warn about: the harness loads one of them (ruling Y14).
   */
  agentNameClashes?(
    scope: Scope,
    scopeRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<Array<{ name: string; files: string[] }>>;
  /** Root config dir for the scope, e.g. <projectRoot>/.claude or ~/.claude. */
  configDir(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string;
  /** Output directories this target writes to at a scope (lock form), for overlap checks. */
  outputDirs(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string[];
  /**
   * Where each installable kind goes at a scope (`describe target`): lock-form places with
   * `<name>` for the entity; `active` is the scope's target set (shared skill directories).
   */
  placements?(
    at: { scope: Scope; scopeRoot: string; env: NodeJS.ProcessEnv },
    active: readonly TargetId[],
  ): Array<{ kind: Exclude<Kind, 'plugin'>; where: string }>;
  /** Compute every file and fragment for the entity. No writes. */
  render(input: RenderInput): Promise<Rendered>;
  /** Write a render: collision policy, merges, journaling and rollback (DESIGN.md section 2). */
  apply(input: ApplyInput): Promise<ApplyResult>;
  /**
   * Remove exactly `entry.files` inside this target's roots and the assets dir, prune emptied
   * dirs, and unmerge `entry.merged` by (at, key). `env` as in RenderInput.
   */
  undeploy(
    entry: LockEntry,
    scope: Scope,
    scopeRoot: string,
    dryRun: boolean,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine collaborators (implemented in the named files)
// ---------------------------------------------------------------------------

/**
 * Collaborators the engine calls into (src/engine/deps.ts supplies lazily imported
 * defaults; tests pass fakes as `Partial<EngineDeps>`).
 */
export interface EngineDeps {
  /** default: src/index/scan.ts `scanSource` */
  scan: (root: string, source: Source) => Promise<ScanResult>;
  /** default: src/targets/index.ts `getTarget` */
  getTarget: (id: TargetId) => Target;
  /** default: src/exec/units.ts `execUnitOf`: builds the unit from an entity and its renders */
  execUnit: (
    entity: Entity,
    renders: Partial<Record<TargetId, Rendered>>,
    closure: { root: string; inPlace: boolean; files: ClosureFile[]; abs?: string },
    from?: ExecUnit['from'],
  ) => ExecUnit;
  /** default: src/exec/consent.ts `askConsent`: prompt, `--allow-exec`, or E_UNTRUSTED_EXEC */
  askConsent: (ctx: PalmContext, req: ConsentRequest) => Promise<ConsentOutcome>;
  /** default: src/secrets/scan.ts `scanSecrets` */
  scanSecrets: (value: unknown, where: string) => SecretFinding[];
  /** default: src/secrets/policy.ts `decideSecret` */
  decideSecret: (input: {
    scope: Scope;
    fromSource: boolean;
    requested?: SecretPolicy;
    destinationAbs: string;
    force: boolean;
  }) => Promise<SecretDecision>;
  /** default: src/secrets/resolve.ts `resolveSecrets`: env lookup and masked prompts under `literal` */
  resolveSecrets: (
    ctx: PalmContext,
    cfg: McpServerConfig,
    policy: SecretPolicy,
  ) => Promise<{ values: Record<string, string>; envRefs: string[] }>;
}
