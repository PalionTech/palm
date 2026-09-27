# palm — internal module API

Signatures every module exports. Modules are written in parallel against this
file; do not rename or change parameter order without updating it. Types come
from `src/core/types.ts`. All local imports use the `.js` suffix (NodeNext).

## src/core (owner: core agent)

```ts
// paths.ts
export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv): PalmPaths;
export function scopeRoot(paths: PalmPaths, scope: Scope): string;          // projectRoot | home
export function manifestPath(paths: PalmPaths, scope: Scope): string;       // <root>/palm.yaml | <palmHome>/palm.yaml
export function lockPath(paths: PalmPaths, scope: Scope): string;
export function hooksAssetDir(paths: PalmPaths, scope: Scope, entityName: string): string; // <projectRoot>/.palm/hooks/<n> | <palmHome>/hooks/<n>

// context.ts
export interface ContextInit { cwd: string; env: NodeJS.ProcessEnv; ui: UI; log: Logger; flags: PalmContext['flags'] }
export async function createContext(init: ContextInit): Promise<PalmContext>;

// config.ts
export async function loadConfig(paths: PalmPaths): Promise<PalmConfig>;
export async function saveConfig(paths: PalmPaths, cfg: PalmConfig): Promise<void>;
export function parseOriginInput(input: string, opts?: { alias?: string; ref?: string; root?: string; layout?: LayoutDescriptor }): OriginSpec; // owner/repo, owner/repo/sub/dir, github:owner/repo, URL[#ref], local path
export function deriveAlias(spec: OriginSpec, existing: OriginSpec[]): string;
export function originId(spec: OriginSpec): string;
export async function addOrigin(ctx: PalmContext, spec: OriginSpec, opts?: { scope?: Scope }): Promise<OriginSpec>; // saves to config (global) or manifest.origins (project)
export async function removeOrigin(ctx: PalmContext, alias: string): Promise<void>;
export function findOrigin(ctx: PalmContext, alias: string): OriginSpec | undefined;   // config + project manifest origins
export function allOrigins(ctx: PalmContext): OriginSpec[];
export async function ensureMineOrigin(ctx: PalmContext): Promise<OriginSpec>; // creates <palmHome>/mine (+ git init) and registers alias "mine"

// manifest.ts
export function parseDepRef(spec: string): DepRef;
export function formatDepRef(ref: DepRef): string;
export function normalizeDep(spec: DepSpec): DepRef;
export async function loadManifest(file: string): Promise<Manifest>;          // {} when missing
export async function saveManifest(file: string, m: Manifest): Promise<void>;
export function addDep(m: Manifest, kind: Kind, dep: DepRef | McpManifestEntry): Manifest;
export function removeDep(m: Manifest, kind: Kind, name: string): Manifest;
export function listDeps(m: Manifest, kind: Kind): Array<DepRef | McpManifestEntry>;

// lockfile.ts
export async function loadLock(file: string): Promise<Lockfile>;              // {version:1, entries:[]} when missing
export async function saveLock(file: string, lock: Lockfile): Promise<void>;
export function upsertEntry(lock: Lockfile, entry: LockEntry): Lockfile;
export function removeEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): Lockfile;
export function findEntry(lock: Lockfile, kind: Kind, name: string, origin?: string): LockEntry | undefined;

// git.ts
export async function fetchOrigin(ctx: PalmContext, spec: OriginSpec, opts?: { refresh?: boolean }): Promise<OriginCheckout>;
export async function listRemoteTags(url: string): Promise<string[]>;
export function latestSemverTag(tags: string[]): string | undefined;

// cache.ts
export async function getIndex(ctx: PalmContext, spec: OriginSpec, opts?: { refresh?: boolean; scan?: ScanOriginFn }): Promise<OriginIndex>;
export async function getAllIndexes(ctx: PalmContext, opts?: { refresh?: boolean; scan?: ScanOriginFn }): Promise<OriginIndex[]>;
export async function invalidateIndex(ctx: PalmContext, spec: OriginSpec): Promise<void>;

// hash.ts
export async function hashPath(absPath: string): Promise<string>;             // "sha256:<hex>", dir = sorted (relpath + content)
```

## src/engine (owner: core agent)

```ts
export interface EngineDeps {
  scan: ScanOriginFn;                                   // default: src/index/scan.js
  getTarget: (id: TargetId) => Target;                  // default: src/targets/index.js
  resolveRegistry: ResolveRegistryFn;                   // default: src/mcp/registry.js
  resolveSecrets: (ctx: PalmContext, cfg: McpServerConfig, policy: SecretPolicy) => Promise<{ values: Record<string, string>; envRefs: string[] }>; // default: src/mcp/secrets.js
}

// install.ts
export async function installEntities(ctx: PalmContext, requests: InstallRequest[], opts: InstallOptions, deps?: Partial<EngineDeps>): Promise<InstallResult>;
// uninstall.ts
export async function uninstallEntities(ctx: PalmContext, refs: Array<{ kind?: Kind; name: string; origin?: string }>, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<{ removed: LockEntry[]; warnings: string[] }>;
// sync.ts
export async function syncManifest(ctx: PalmContext, opts: { scope: Scope; prune: boolean; targets?: TargetId[] }, deps?: Partial<EngineDeps>): Promise<InstallResult & { extraneous: LockEntry[] }>;
// update.ts
export async function updateEntities(ctx: PalmContext, refs: Array<{ kind?: Kind; name: string }>, opts: { scope: Scope }, deps?: Partial<EngineDeps>): Promise<InstallResult>;
// resolve-targets.ts
export async function resolveTargets(ctx: PalmContext, opts: { scope: Scope; flag?: TargetId[]; save?: boolean }, deps?: Partial<EngineDeps>): Promise<TargetId[]>;
// query.ts
export async function listInstalled(ctx: PalmContext, scope: Scope, kind?: Kind): Promise<LockEntry[]>;
export async function findCandidates(ctx: PalmContext, kind: Kind | undefined, name: string, opts: { origin?: string; from?: OriginSpec; refresh?: boolean }, deps?: Partial<EngineDeps>): Promise<Entity[]>;
export async function searchIndex(ctx: PalmContext, query: string, opts: { kind?: Kind; origin?: string; refresh?: boolean }, deps?: Partial<EngineDeps>): Promise<Array<{ entity: Entity; score: number }>>;
export async function getEntityInfo(ctx: PalmContext, kind: Kind, name: string, opts: { origin?: string; scope: Scope }, deps?: Partial<EngineDeps>): Promise<{ entity?: Entity; lock?: LockEntry; deps: EntityRef[] }>;
```

## src/index (owner: scanner agent)

```ts
// scan.ts
export const scanOrigin: ScanOriginFn;                    // (root, spec) => ScanResult
// marketplace.ts
export const parseMarketplace: ParseMarketplaceFn;        // expand marketplace.json → OriginSpec[]
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
export function convertHooks(hooks: HookSet, target: TargetId, pluginRootAbs: string, scope: Scope): { hooks: unknown; dropped: string[] };
// mcp-config.ts
export function renderMcpEntry(cfg: McpServerConfig, target: TargetId, policy: SecretPolicy, values?: Record<string, string>): unknown; // harness-specific object/table
// json-merge.ts
export async function mergeJsonFile(file: string, pointer: string, key: string | undefined, value: unknown, opts: { dryRun: boolean }): Promise<MergedRecord>;
export async function unmergeJsonFile(file: string, record: MergedRecord): Promise<void>;
// toml-merge.ts (codex)
export async function mergeTomlTable(file: string, tablePath: string[], value: Record<string, unknown>, opts: { dryRun: boolean }): Promise<MergedRecord>;
export async function unmergeTomlTable(file: string, record: MergedRecord): Promise<void>;
// managed-block.ts (AGENTS.md sections)
export async function upsertManagedBlock(file: string, id: string, content: string, opts: { dryRun: boolean }): Promise<MergedRecord>;
export async function removeManagedBlock(file: string, id: string): Promise<void>;
```

## src/mcp (owner: mcp agent)

```ts
// registry.ts
export const searchRegistry: SearchRegistryFn;
export const resolveRegistry: ResolveRegistryFn;
export const DEFAULT_REGISTRY_URL: string;
// serverjson.ts
export function serverJsonToConfig(serverJson: unknown): McpServerConfig;
// secrets.ts
export async function resolveSecrets(ctx: PalmContext, cfg: McpServerConfig, policy: SecretPolicy): Promise<{ values: Record<string, string>; envRefs: string[] }>;
export function detectSecrets(cfg: McpServerConfig): SecretRef[];   // ${VAR} placeholders in env/headers → SecretRef
// adhoc.ts
export function parseAdhocMcp(name: string, opts: { command?: string[]; url?: string; headers?: string[]; env?: string[]; transport?: string }): McpServerConfig;
```

## src/cli.ts, src/commands/*, src/ui/*, src/create/* (owner: cli agent)

```ts
// ui/prompts.ts
export function createClackUI(): UI;
export function createNonInteractiveUI(): UI;             // every prompt throws PalmError('E_NON_INTERACTIVE', ...)
// ui/output.ts
export function createLogger(opts: { verbose: boolean; json?: boolean }): Logger;
export function printInstallSummary(result: InstallResult, opts: { scope: Scope; targets: TargetId[] }): void;
export function printTable(rows: string[][], header?: string[]): void;
// create/agent.ts etc.
export async function createAgent(ctx: PalmContext, opts: { name?: string; install?: boolean; scope: Scope }): Promise<void>;
export async function createSkill(ctx: PalmContext, opts: { name?: string; install?: boolean; scope: Scope }): Promise<void>;
export async function createInstruction(ctx: PalmContext, opts: { name?: string; install?: boolean; scope: Scope }): Promise<void>;
export async function createCommand(ctx: PalmContext, opts: { name?: string; install?: boolean; scope: Scope }): Promise<void>;
```

## Ownership map

| Directory | Owner |
|---|---|
| `src/core/**` (except types/kinds/errors), `src/engine/**`, `test/core`, `test/engine` | core agent |
| `src/index/**`, `test/index`, `test/fixtures/**` | scanner agent |
| `src/targets/**`, `test/targets` | targets agent |
| `src/mcp/**`, `test/mcp` | mcp agent |
| `src/cli.ts`, `src/commands/**`, `src/ui/**`, `src/create/**`, `test/cli` | cli agent |

Nobody edits `package.json`, `tsconfig.json`, `DESIGN.md`, `API.md`, `src/core/types.ts`, `src/core/kinds.ts`, `src/core/errors.ts`. Missing types are defined locally and reported.
