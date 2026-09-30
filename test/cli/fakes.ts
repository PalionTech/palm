/**
 * The engine, the scope and the UI as the CLI tests see them. Every engine operation goes
 * through `CliOptions.deps` (src/create/engine.ts), so a test hands `runCli` exactly the
 * results it wants printed and reads back the requests the CLI made.
 */
import { join } from 'node:path';
import { type CliOptions, runCli } from '../../src/commands/main.js';
import { PalmError } from '../../src/core/errors.js';
import type {
  ConsentAnswer,
  EngineDeps,
  Entity,
  InstallOutcome,
  LockEntry,
  LockSource,
  PickOption,
  Scope,
  Source,
  Target,
  TargetId,
  UI,
} from '../../src/core/types.js';
import type { CliDeps, EngineApi, ScopeState, SourceRef } from '../../src/create/engine.js';
import type { Sandbox } from '../support/sandbox.js';

// scope ----------------------------------------------------------------------------------------

export interface FakeSource {
  name: string;
  alias?: string;
  url?: string;
  path?: string;
  ref?: string;
}

export interface ScopeSpec {
  root: string;
  scope?: Scope;
  /** `targets:` in palm.yaml; absent until an install writes it. */
  manifestTargets?: TargetId[];
  /** The scope's targets (palm.yaml, else what detection found). */
  targets?: TargetId[];
  sources?: FakeSource[];
  lockSources?: Record<string, LockSource>;
  entries?: LockEntry[];
}

export function fakeSourceRef(s: FakeSource): SourceRef {
  const source: Source = {
    name: s.name,
    type: s.path ? 'local' : 'git',
    ...(s.url ? { url: s.url } : {}),
    ...(s.path ? { path: s.path } : {}),
    ...(s.ref ? { ref: s.ref } : {}),
  };
  const where = s.path ?? s.url ?? `https://github.com/${s.name}.git`;
  return {
    source,
    name: s.name,
    alias: s.alias,
    isLocal: Boolean(s.path),
    isGit: !s.path,
    describe: () => where,
    matches: (q: string) => q === s.name || q === s.alias || q === s.path,
  } as unknown as SourceRef;
}

export function fakeScope(spec: ScopeSpec): ScopeState {
  const refs = (spec.sources ?? []).map(fakeSourceRef);
  const entries = spec.entries ?? [];
  const lockSources = spec.lockSources ?? {};
  const scope = spec.scope ?? 'project';
  const byName = (n: string) =>
    refs.find((r) => [r.name, r.alias].some((x) => x?.toLowerCase() === n.toLowerCase()));
  return {
    paths: {
      scope,
      root: spec.root,
      manifestFile: join(spec.root, 'palm.yaml'),
      lockFile: join(spec.root, 'palm.lock.yaml'),
    },
    manifest: { targets: spec.manifestTargets },
    lock: {
      size: entries.length,
      entries,
      sources: lockSources,
      source: (n: string) => lockSources[n],
      entriesOf: (n: string) => entries.filter((e) => e.source === n),
    },
    sources: { all: () => refs, byName, names: () => refs.map((r) => r.name), size: refs.length },
    targets: spec.targets ?? spec.manifestTargets ?? [],
  } as unknown as ScopeState;
}

// targets --------------------------------------------------------------------------------------

const CONFIG_DIR: Readonly<Record<TargetId, string>> = {
  claude: '.claude',
  codex: '.codex',
  copilot: '.github',
  cursor: '.cursor',
  gemini: '.gemini',
  opencode: '.opencode',
};

function fakeTarget(id: TargetId): Target {
  const refuse = async (): Promise<never> => {
    throw new Error(`fake target ${id} does not render`);
  };
  return {
    id,
    displayName: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
    detect: async () => false,
    configDir: (_scope, root) => join(root, CONFIG_DIR[id]),
    outputDirs: () => [`${CONFIG_DIR[id]}/skills`, `${CONFIG_DIR[id]}/agents`],
    render: refuse,
    apply: refuse,
    undeploy: refuse,
  };
}

// engine ---------------------------------------------------------------------------------------

/** API semantics of src/exec/units.ts `isExecutable`: a hook with a command, or a stdio server. */
function isExecutable(e: Entity): boolean {
  if (e.def.kind === 'mcp') return e.def.mcp.transport === 'stdio';
  if (e.def.kind !== 'hook') return false;
  return JSON.stringify(e.def.hooks.raw).includes('"command"');
}

export type FakeEngine = CliDeps & { calls: Record<string, unknown[][]> };

type Overrides = Partial<EngineApi> & Partial<EngineDeps> & { scopes?: ScopeState[] };

const OPERATIONS: ReadonlyArray<keyof EngineApi> = [
  'openScope',
  'installFromSource',
  'listSource',
  'installMcp',
  'syncScope',
  'removeEntities',
  'planUpdate',
  'applyUpdate',
  'planChanges',
  'reviewText',
  'checkScope',
  'migrateScope',
  'listInstalled',
  'describeEntity',
  'ownerOfPath',
  'detectTargets',
  'requestInstallStop',
  'resolveEngineDeps',
  'isExecutable',
  'parseAllowExec',
  'parseMcpJson',
  'enclosingProject',
  'cleanCache',
  'scopePaths',
  'loadManifest',
];

function defaults(scopes: ScopeState[]): Partial<EngineApi> {
  let opened = 0;
  return {
    openScope: async () => {
      const state = scopes[Math.min(opened, scopes.length - 1)];
      opened++;
      if (!state) throw new Error('fake engine: no scope given');
      return state;
    },
    isExecutable,
    parseAllowExec: (text) => (text === 'all' ? 'all' : []),
    requestInstallStop: () => undefined,
    resolveEngineDeps: async (partial) =>
      ({ getTarget: fakeTarget, ...partial }) as unknown as EngineDeps,
  };
}

/**
 * Fake engine operations for `CliOptions.deps`. An operation a test did not give throws, so an
 * unexpected call fails loudly; every call is recorded in `calls` (arguments without ctx).
 */
export function fakeEngine(over: Overrides = {}): FakeEngine {
  const { scopes = [], ...given } = over;
  const base: Record<string, unknown> = { getTarget: fakeTarget, ...defaults(scopes), ...given };
  const calls: Record<string, unknown[][]> = {};
  const deps: Record<string, unknown> = { ...base, calls };
  for (const op of OPERATIONS) {
    const fn = base[op] as ((...args: unknown[]) => unknown) | undefined;
    deps[op] = (...args: unknown[]) => {
      calls[op] = [...(calls[op] ?? []), args.slice(1)];
      if (!fn) throw new Error(`fake engine: ${op} was not expected`);
      return fn(...args);
    };
  }
  return deps as FakeEngine;
}

// outcomes -------------------------------------------------------------------------------------

export function lockEntry(
  e: Partial<LockEntry> & Pick<LockEntry, 'kind' | 'name' | 'source'>,
): LockEntry {
  return { path: e.name, content: 'sha256:0', render: {}, files: [], ...e };
}

export function outcome(
  entry: LockEntry,
  status: InstallOutcome['status'] = 'installed',
  notes: string[] = [],
): InstallOutcome {
  return { entry, status, notes };
}

// UI -------------------------------------------------------------------------------------------

export interface FakeUIOptions {
  interactive?: boolean;
  confirm?: boolean;
  consent?: ConsentAnswer[];
}

/** A UI that answers from a script; without a terminal every prompt is E_NON_INTERACTIVE. */
export function fakeUI(opts: FakeUIOptions = {}): UI & { asked: string[] } {
  const asked: string[] = [];
  const answers = [...(opts.consent ?? [])];
  const ask = <T>(message: string, answer: T): T => {
    if (!opts.interactive) throw new PalmError('E_NON_INTERACTIVE', `no terminal: ${message}`);
    asked.push(message);
    return answer;
  };
  return {
    asked,
    isInteractive: Boolean(opts.interactive),
    pick: async <T>(m: string, o: PickOption<T>[]) => ask(m, (o[0] as PickOption<T>).value),
    pickMany: async <T>(m: string, o: PickOption<T>[]) =>
      ask(
        m,
        o.map((x) => x.value),
      ),
    confirm: async (m: string) => ask(m, opts.confirm ?? false),
    text: async (m: string) => ask(m, ''),
    secret: async (m: string) => ask(m, ''),
    consent: async (text: string) => ask(text, answers.shift() ?? 'no'),
    spinner: () => ({ stop() {}, message() {} }),
  };
}

// running --------------------------------------------------------------------------------------

export interface Ran {
  stdout: string;
  stderr: string;
  code: number;
}

/** `runCli` in process over string buffers, in the sandbox project with a hermetic env. */
export async function palm(
  sb: Sandbox,
  argv: string[],
  opts: Omit<CliOptions, 'stdout' | 'stderr'> = {},
): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    cwd: sb.project,
    env: { ...sb.env, NO_COLOR: '1' },
    ui: fakeUI(),
    ...opts,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { stdout, stderr, code };
}
