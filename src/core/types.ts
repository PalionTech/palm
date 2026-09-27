/**
 * palm — shared type contract. See DESIGN.md.
 *
 * Every module imports its types from here. Extend this file (and DESIGN.md)
 * rather than inventing private shapes.
 */

// ---------------------------------------------------------------------------
// Kinds, targets, scopes
// ---------------------------------------------------------------------------

export type Kind =
  | 'skill'
  | 'agent'
  | 'instruction'
  | 'command'
  | 'hook'
  | 'mcp'
  | 'plugin';

export const KINDS: readonly Kind[] = [
  'skill',
  'agent',
  'instruction',
  'command',
  'hook',
  'mcp',
  'plugin',
] as const;

export type TargetId = 'claude' | 'codex' | 'copilot' | 'cursor';

export const TARGET_IDS: readonly TargetId[] = ['claude', 'codex', 'copilot', 'cursor'] as const;

export type Scope = 'project' | 'global';

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/** Optional override of layout auto-detection for one origin. Globs are relative to the origin root. */
export interface LayoutDescriptor {
  /** Globs matching directories that contain SKILL.md. */
  skills?: string | string[];
  /** Globs matching agent definition files. */
  agents?: string | string[];
  /** Globs matching command/prompt files. */
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

export interface OriginSpec {
  /** Short handle used in `name@alias`. Unique within the config. */
  alias: string;
  type: 'git' | 'local';
  /** git: normalized clone URL (https://github.com/owner/repo.git or ssh form). */
  url?: string;
  /** local: absolute directory path. */
  path?: string;
  /** git: requested ref (tag, branch or sha). Absent = latest semver tag, else default branch. */
  ref?: string;
  /** Subdirectory inside the repo that is the real origin root. */
  root?: string;
  layout?: LayoutDescriptor;
  /** Free-form note shown in `palm origin list`. */
  description?: string;
}

/** Result of fetching an origin into the cache. */
export interface OriginCheckout {
  spec: OriginSpec;
  /** Cache dir name; see DESIGN.md §5. */
  originId: string;
  /** Absolute path to the directory that should be scanned (repo root + spec.root). */
  root: string;
  /** Absolute path to the repository checkout (before `root` is applied). */
  repoDir: string;
  /** Resolved commit sha (git origins) or undefined (local). */
  sha?: string;
  /** The ref that was actually checked out (tag/branch name or sha). */
  ref?: string;
  fetchedAt: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Entities (what the index contains)
// ---------------------------------------------------------------------------

export interface EntityRef {
  kind: Kind;
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
  /** Where this config came from, for display. */
  source?: { type: 'origin' | 'registry' | 'adhoc'; ref?: string; version?: string };
}

export interface SecretRef {
  /** Environment variable name (also used as placeholder name). */
  name: string;
  /** Where it is used. */
  in: 'env' | 'header';
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
  /** Skill names this agent depends on. */
  skills?: string[];
  /** MCP server names this agent depends on. */
  mcpServers?: string[];
  /**
   * Instructions installed alongside the agent (palm extension, `instructions:` frontmatter).
   * Entries are dependency strings `name[@origin]`; no harness reads this key, palm strips it on deploy.
   */
  instructions?: string[];
  color?: string;
  /** The system prompt (markdown body). */
  body: string;
  /** Unmapped frontmatter keys, passed through to targets that understand them. */
  extra?: Record<string, unknown>;
  /** Format the source file was in. */
  sourceFormat?: 'claude-md' | 'copilot-agent-md' | 'codex-toml' | 'cursor-md' | 'apm-agent-md';
}

export interface InstructionDefinition {
  name: string;
  description?: string;
  /** Path globs the instruction applies to; empty/undefined = always. */
  globs?: string[];
  alwaysApply: boolean;
  body: string;
  sourceFormat?: 'md' | 'mdc' | 'instructions-md' | 'agents-md';
}

export interface CommandDefinition {
  name: string;
  description?: string;
  argumentHint?: string;
  body: string;
  sourceFormat?: 'claude-md' | 'prompt-md' | 'gemini-toml' | 'opencode-md';
}

export type HookDialect = 'claude' | 'cursor' | 'copilot' | 'gemini' | 'unknown';

export interface HookSet {
  name: string;
  dialect: HookDialect;
  /** Parsed JSON of the hooks file (or the inline manifest block). */
  raw: unknown;
  /** Directory (relative to origin root) that `${CLAUDE_PLUGIN_ROOT}` / `${CURSOR_PLUGIN_ROOT}` refer to. */
  pluginRootRel?: string;
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
  extra?: Record<string, unknown>;
}

export interface Entity {
  kind: Kind;
  /** Canonical id: slug for skills/agents/plugins, server key for mcp. */
  name: string;
  description?: string;
  version?: string;
  /**
   * Location relative to the origin root:
   * skill/plugin → directory; agent/command/instruction/hook → file; mcp → the config file.
   */
  path: string;
  /** Origin alias. */
  origin: string;
  /** Containing plugin name, when the entity was found through a plugin manifest. */
  plugin?: string;
  /** Kind-specific parsed definition. */
  def:
    | { kind: 'skill'; skill: SkillDefinition }
    | { kind: 'agent'; agent: AgentDefinition }
    | { kind: 'instruction'; instruction: InstructionDefinition }
    | { kind: 'command'; command: CommandDefinition }
    | { kind: 'hook'; hooks: HookSet }
    | { kind: 'mcp'; mcp: McpServerConfig }
    | { kind: 'plugin'; members: EntityRef[]; manifestPath?: string };
}

export interface ScanResult {
  entities: Entity[];
  /** Human-readable notes: remote marketplace entries not fetched, name mismatches, skipped files. */
  warnings: string[];
  /** Which detection rule fired (for `palm origin list --verbose`). */
  detected: 'descriptor' | 'apm' | 'marketplace' | 'plugin-manifest' | 'convention' | 'empty';
}

export interface OriginIndex extends ScanResult {
  origin: string;
  originId: string;
  sha?: string;
  ref?: string;
  root: string;
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// Manifest & lockfile
// ---------------------------------------------------------------------------

/** `<name>[@<origin>][#<ref>]` parsed. */
export interface DepRef {
  name: string;
  origin?: string;
  ref?: string;
}

/** Ad hoc MCP definition inside palm.yaml. */
export interface McpManifestEntry {
  name: string;
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** MCP registry name when the entry came from the registry. */
  registry?: string;
  version?: string;
}

export type DepSpec = string | DepRef;

export interface Manifest {
  targets?: TargetId[];
  origins?: Array<string | OriginSpec>;
  skills?: DepSpec[];
  agents?: DepSpec[];
  instructions?: DepSpec[];
  commands?: DepSpec[];
  hooks?: DepSpec[];
  mcp?: Array<string | McpManifestEntry>;
  plugins?: DepSpec[];
}

export interface MergedRecord {
  /** File that received the merged fragment (scope-relative for project, absolute for global). */
  file: string;
  /** JSON pointer (RFC 6901) to the array/object where `value` was inserted. */
  pointer: string;
  /** Exact value inserted, for removal by deep-equality. */
  value: unknown;
}

export interface LockEntry {
  kind: Kind;
  name: string;
  origin: string;
  url?: string;
  ref?: string;
  sha?: string;
  path: string;
  contentHash: string;
  installedAt: string;
  targets: TargetId[];
  files: string[];
  merged?: MergedRecord[];
  /** `plugin:<name>` or `agent:<name>` when installed as a dependency. */
  via?: string;
  /**
   * Plugin/agent entries only: the entities it declared (plugin members; agent skills, MCP
   * servers and instructions). Uninstall keeps a `via` dependency while any remaining entry
   * lists it here (reference counting), and re-parents it to that entry.
   */
  deps?: EntityRef[];
}

export interface Lockfile {
  version: 1;
  entries: LockEntry[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PalmConfig {
  targets?: TargetId[];
  origins: OriginSpec[];
  /** Secret placement default per scope. */
  secrets?: { project?: SecretPolicy; global?: SecretPolicy };
  mcpRegistryUrl?: string;
}

export type SecretPolicy = 'env-ref' | 'literal';

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
  text(message: string, opts?: { placeholder?: string; initial?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  secret(message: string): Promise<string>;
  spinner(message: string): { stop(msg?: string): void; message(msg: string): void };
}

export interface PalmPaths {
  /** $PALM_HOME or ~/.palm */
  palmHome: string;
  /** User home (respecting HOME override in tests). */
  home: string;
  /** Project root for project scope (see DESIGN.md §2). */
  projectRoot: string;
  cwd: string;
}

export interface PalmContext {
  paths: PalmPaths;
  config: PalmConfig;
  ui: UI;
  log: Logger;
  env: NodeJS.ProcessEnv;
  flags: {
    yes: boolean;
    dryRun: boolean;
    force: boolean;
    offline: boolean;
    verbose: boolean;
  };
}

// ---------------------------------------------------------------------------
// Engine requests/results
// ---------------------------------------------------------------------------

export interface InstallRequest {
  kind?: Kind;
  spec: DepSpec;
  /** Ad hoc origin for this request (unregistered), already parsed. */
  from?: OriginSpec;
  /** Ad hoc MCP definition (`palm install mcp name -- cmd` / `--url`). */
  adhocMcp?: McpServerConfig;
  /** Resolve this MCP registry name directly (manifest `{ registry: … }` entries; used by sync/update). */
  registry?: string;
}

export interface InstallOptions {
  scope: Scope;
  targets: TargetId[];
  secretPolicy?: SecretPolicy;
  /** Don't record in manifest (used for `via` dependencies and sync). */
  noSave?: boolean;
}

export interface InstallOutcome {
  entry: LockEntry;
  status: 'installed' | 'updated' | 'unchanged' | 'skipped';
  notes: string[];
}

export interface InstallResult {
  outcomes: InstallOutcome[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Target interface (src/targets/*)
// ---------------------------------------------------------------------------

/** Everything a target needs to write one entity. */
export interface DeployInput {
  entity: Entity;
  /** Absolute path of the entity on disk (dir for skill/plugin, file otherwise). */
  absPath: string;
  /** Absolute origin root (for resolving plugin-relative assets). */
  originRoot: string;
  scope: Scope;
  /** Absolute directory that scope-relative paths resolve against (projectRoot or home). */
  scopeRoot: string;
  secretPolicy: SecretPolicy;
  /** Resolved secret values when policy is literal. */
  secretValues?: Record<string, string>;
  dryRun: boolean;
  force: boolean;
  /** Files already owned by this entity in the lock (may be overwritten). Merged keys appear as `file#pointer`. */
  ownedFiles: string[];
  /** Environment for CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / PALM_HOME resolution (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface DeployResult {
  /** Files written, scope-relative for project scope, absolute for global. */
  files: string[];
  merged?: MergedRecord[];
  notes: string[];
  /** True when the target has nothing to do for this kind/scope (documented gap). */
  skipped?: boolean;
}

export interface Target {
  id: TargetId;
  displayName: string;
  /** True when the harness appears to be in use at this scope. */
  detect(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Root config dir for the scope, e.g. <projectRoot>/.claude or ~/.claude. */
  configDir(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string;
  deploy(input: DeployInput): Promise<DeployResult>;
  /**
   * Remove the given files/merged records previously produced by deploy.
   * `env` resolves CLAUDE_CONFIG_DIR / CODEX_HOME / … like `DeployInput.env` (default: process.env).
   */
  undeploy(entry: LockEntry, scope: Scope, scopeRoot: string, dryRun: boolean, env?: NodeJS.ProcessEnv): Promise<void>;
}

// ---------------------------------------------------------------------------
// Module function contracts (implemented in the named files)
// ---------------------------------------------------------------------------

/** src/index/scan.ts */
export type ScanOriginFn = (root: string, spec: OriginSpec) => Promise<ScanResult>;

/** src/index/marketplace.ts — expand a marketplace.json into origin specs. */
export type ParseMarketplaceFn = (
  file: string,
  base: { url?: string; path?: string; ref?: string },
) => Promise<{ origins: OriginSpec[]; warnings: string[] }>;

/** src/mcp/registry.ts */
export interface RegistryCandidate {
  name: string;
  description?: string;
  version?: string;
  config: McpServerConfig;
}
export type SearchRegistryFn = (query: string, opts: { registryUrl?: string; limit?: number }) => Promise<RegistryCandidate[]>;
export type ResolveRegistryFn = (name: string, opts: { registryUrl?: string; version?: string }) => Promise<RegistryCandidate[]>;

/** src/core/git.ts */
export type FetchOriginFn = (ctx: PalmContext, spec: OriginSpec) => Promise<OriginCheckout>;

/** src/mcp/secrets.ts `resolveSecrets`. */
export type ResolveSecretsFn = (
  ctx: PalmContext,
  cfg: McpServerConfig,
  policy: SecretPolicy,
) => Promise<{ values: Record<string, string>; envRefs: string[] }>;

/**
 * Collaborators the engine calls into (src/engine/deps.ts supplies lazily imported
 * defaults; tests pass fakes as `Partial<EngineDeps>`).
 */
export interface EngineDeps {
  /** default: src/index/scan.ts `scanOrigin` */
  scan: ScanOriginFn;
  /** default: src/targets/index.ts `getTarget` */
  getTarget: (id: TargetId) => Target;
  /** default: src/mcp/registry.ts `resolveRegistry` */
  resolveRegistry: ResolveRegistryFn;
  /** default: src/mcp/secrets.ts `resolveSecrets` */
  resolveSecrets: ResolveSecretsFn;
}
