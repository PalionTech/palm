/** `palm install [kind] [names...]` (aliases `add`, `i`); `install origin` lives in origin.ts. */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import type {
  EngineDeps,
  InstallRequest,
  InstallResult,
  Kind,
  LockEntry,
  OriginSpec,
  PalmContext,
  Scope,
  SecretPolicy,
  TargetId,
} from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import type { FoundTargets } from '../engine/resolve-targets.js';
import { type Output, outputOf, printInstallSummary } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { installOrigin } from './origin.js';
import { parseArgv } from './program.js';
import {
  ExitSignal,
  entityKind,
  entries,
  failureCount,
  type GlobalOptions,
  makeContext,
  parseSecretPolicy,
  parseTargetList,
  scopeOf,
} from './shared.js';

export interface AdhocMcpArgs {
  name: string;
  /** Command + args given after `--`. */
  command?: string[];
  url?: string;
  headers: string[];
  env: string[];
  transport?: string;
}

export interface ParsedInstallArgs {
  /** `sync` = bare `palm install` (install what palm.yaml lists). */
  mode: 'install' | 'sync';
  kind?: Kind;
  specs: string[];
  from?: string;
  /** `--save-origin`: register the `--from` origin in config.yaml, or palm.yaml with `--project`. */
  saveOrigin: false | 'global' | 'project';
  secrets?: SecretPolicy;
  prune: boolean;
  /** `--frozen`: install exactly what the lock records; any difference is an error. */
  frozen: boolean;
  adhoc?: AdhocMcpArgs;
  scope: Scope;
  targets?: TargetId[];
  global: GlobalOptions;
}

interface InstallCliOptions extends GlobalOptions {
  from?: string;
  saveOrigin?: boolean;
  secrets?: string;
  prune?: boolean;
  frozen?: boolean;
  url?: string;
  header?: string[];
  env?: string[];
  transport?: string;
  alias?: string;
  ref?: string;
  root?: string;
  layout?: string[];
  project?: boolean;
}

const ADHOC_HINT =
  'palm install mcp <name> -- <command> [args...]   or   palm install mcp <name> --url <url> [--header K=V]';
const REPO_PREFIX = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@|github:|gitlab:)/i;
const ORIGIN_ONLY = ['alias', 'ref', 'root', 'layout', 'project'] as const;

/**
 * True when a spec names a repository or path rather than an entity: a git URL, `github:`/`gitlab:`,
 * a relative/home path, or `owner/repo` (an MCP registry name like `io.github.x/y` has a dot in its
 * first segment and does not count).
 */
export function looksLikeRepoRef(spec: string): boolean {
  const s = spec.trim();
  if (REPO_PREFIX.test(s) || s === '.' || s === '..' || s === '~' || s.startsWith('~/'))
    return true;
  let name: string;
  try {
    name = DepRef.parse(s).name;
  } catch {
    return false;
  }
  const first = name.split('/')[0] ?? '';
  if (!name.includes('/') || first.startsWith('@')) return false; // npm scope: registry / not found
  return first.startsWith('.') || !first.includes('.');
}

export function repoRefError(spec: string): PalmError {
  return new PalmError(
    'E_USAGE',
    `"${spec}" is a repository, not an entity name`,
    `register it: palm install origin ${spec}   or take one entity from it: palm install skill <name> --from ${spec}`,
  );
}

/** True when `spec` (a bare name that matched nothing) is a directory, relative to the cwd. */
function isDirectory(ctx: PalmContext, spec: string): boolean {
  try {
    return statSync(resolve(ctx.paths.cwd, spec)).isDirectory();
  } catch {
    return false;
  }
}

function adhocArgs(
  kind: Kind | undefined,
  specs: string[],
  opts: InstallCliOptions,
  passthrough: string[],
): AdhocMcpArgs | undefined {
  const headers = opts.header ?? [];
  const env = opts.env ?? [];
  const requested =
    passthrough.length > 0 ||
    !!opts.url ||
    headers.length > 0 ||
    env.length > 0 ||
    !!opts.transport;
  if (!requested) return undefined;
  if (kind !== 'mcp')
    throw usage(
      '`--`, --url, --header, --env and --transport define an ad hoc MCP server and need the mcp kind',
      ADHOC_HINT,
    );
  if (specs.length !== 1) throw usage('an ad hoc MCP server needs exactly one name', ADHOC_HINT);
  if (passthrough.length === 0 && !opts.url)
    throw usage('an ad hoc MCP server needs a command after `--` or --url', ADHOC_HINT);
  if (passthrough.length > 0 && opts.url)
    throw usage('give either a command after `--` or --url, not both', ADHOC_HINT);
  const command = passthrough.length ? passthrough : undefined;
  return { name: specs[0] ?? '', command, url: opts.url, headers, env, transport: opts.transport };
}

function checkKindAndSpecs(kind: Kind | undefined, specs: string[], opts: InstallCliOptions): void {
  if (specs[0]?.toLowerCase() === 'registry' && !kind)
    throw usage(
      'registry is not an installable kind',
      'MCP registry servers install with: palm install mcp <registry-name>',
    );
  if (!kind) {
    const repo = specs.find(looksLikeRepoRef);
    if (repo) throw repoRefError(repo);
  }
  // --project also says where --save-origin registers the --from origin
  const originOnly = ORIGIN_ONLY.filter(
    (k) => opts[k] !== undefined && !(k === 'project' && opts.saveOrigin),
  );
  if (originOnly.length)
    throw usage(
      `--${originOnly.join(', --')} only apply to origins`,
      `palm install origin <spec> --${originOnly[0]} …`,
    );
}

function checkMode(mode: 'install' | 'sync', kind: Kind | undefined, opts: InstallCliOptions) {
  if (mode === 'sync' && kind)
    throw usage(
      `name the ${kind} to install`,
      `palm install ${kind} <name>   (or palm install with no arguments for everything in palm.yaml)`,
    );
  if (opts.prune && mode !== 'sync')
    throw usage(
      '--prune only applies to a bare `palm install` (manifest sync)',
      'palm install --prune',
    );
  if (opts.frozen && mode !== 'sync')
    throw usage(
      '--frozen only applies to a bare `palm install` (install what palm.lock.yaml records)',
      'palm install --frozen',
    );
  if (opts.frozen && opts.prune)
    throw usage('--frozen writes nothing, so it cannot --prune', 'palm install --frozen');
  if (opts.saveOrigin && !opts.from)
    throw usage(
      '--save-origin needs --from <origin>',
      'palm install skill <name> --from owner/repo --save-origin',
    );
}

/** Where `--save-origin` registers the `--from` origin: config.yaml, or palm.yaml with --project. */
function saveOriginScope(save?: boolean, project?: boolean): ParsedInstallArgs['saveOrigin'] {
  if (!save) return false;
  return project ? 'project' : 'global';
}

/** Pure interpretation of an install invocation (entity kinds; origins go to origin.ts). */
export function interpretInstallArgs(inv: Invocation, passthrough: string[]): ParsedInstallArgs {
  const opts = inv.opts as InstallCliOptions;
  const kind = entityKind(inv.resource, 'install');
  const specs = inv.names;
  checkKindAndSpecs(kind, specs, opts);
  const adhoc = adhocArgs(kind, specs, opts, passthrough);
  const mode = specs.length === 0 ? 'sync' : 'install';
  checkMode(mode, kind, opts);
  const {
    from,
    saveOrigin,
    project,
    secrets,
    prune,
    frozen,
    url,
    header,
    env,
    transport,
    ...global
  } = opts;
  return {
    mode,
    kind,
    specs,
    from,
    saveOrigin: saveOriginScope(saveOrigin, project),
    secrets: parseSecretPolicy(secrets),
    prune: Boolean(prune),
    frozen: Boolean(frozen),
    adhoc,
    scope: scopeOf(global),
    targets: parseTargetList(global.target),
    global,
  };
}

/** Parse a full user argv (e.g. `['i', 'agent', 'x', '-g']`) exactly as the CLI would. */
export function parseInstallArgs(argv: string[]): ParsedInstallArgs {
  const { invocation, passthrough } = parseArgv(argv);
  if (invocation.command !== 'install' || invocation.resource === 'origin')
    throw usage(`not an entity install command: ${argv.join(' ')}`);
  return interpretInstallArgs(invocation, passthrough);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  if (inv.resource === 'origin') return installOrigin(inv, app);
  const parsed = interpretInstallArgs(inv, app.passthrough);
  const ctx = await makeContext(app, parsed.global);
  await installWithContext(ctx, parsed, { out: app.out, deps: app.deps });
}

interface InstallRun {
  ctx: PalmContext;
  parsed: ParsedInstallArgs;
  out: Output;
  deps?: Partial<EngineDeps>;
}

/** `palm install` against a given context (tests pass a sandbox context and fake UI). */
export async function installWithContext(
  ctx: PalmContext,
  parsed: ParsedInstallArgs,
  opts: { out?: Output; deps?: Partial<EngineDeps> } = {},
): Promise<void> {
  const r: InstallRun = { ctx, parsed, out: opts.out ?? outputOf(ctx.log), deps: opts.deps };
  // Scope guards first (the home directory is no project, …): before any origin or target work.
  const { scopedContext } = await import('../engine/install.js');
  scopedContext(ctx, parsed.scope);
  if (parsed.mode === 'sync') return syncInstall(r);
  const { result, targets } = await installRequests(r);
  finishInstall(r, result, targets);
}

/** The targets of this run; `persistTargets` saves them once the run placed something. */
async function findTargetsFor(r: InstallRun): Promise<FoundTargets> {
  const { findTargets } = await import('../engine/resolve-targets.js');
  return findTargets(r.ctx, { scope: r.parsed.scope, flag: r.parsed.targets }, r.deps);
}

/**
 * Save the targets to palm.yaml when it has none, after an install that placed something: a
 * failed, ambiguous or cancelled run (it threw) saves nothing, and `--frozen` never writes. A
 * `--target` on a later install applies to that install only.
 */
async function saveTargetsAfter(r: InstallRun, found: FoundTargets, result: InstallResult) {
  const { persistTargets, placedSomething } = await import('../engine/resolve-targets.js');
  if (!r.parsed.frozen && placedSomething(result))
    await persistTargets(r.ctx, r.parsed.scope, found);
}

/**
 * The persisted set (palm.yaml / config.yaml, or what this first install persists) and every
 * entry's minimum set for a sync: the persisted set plus any `--target`.
 */
async function syncTargetSets(r: InstallRun, found: FoundTargets) {
  const { persistedTargets } = await import('../engine/resolve-targets.js');
  const persisted = await persistedTargets(r.ctx, r.parsed.scope, found);
  const all = new Set([...(persisted ?? []), ...found.targets]);
  return { persisted, targets: TARGET_IDS.filter((t) => all.has(t)) };
}

async function syncInstall(r: InstallRun): Promise<void> {
  const found = await findTargetsFor(r);
  const { persisted, targets } = await syncTargetSets(r, found);
  const { syncManifest } = await import('../engine/sync.js');
  const { parsed } = r;
  const result: InstallResult & { extraneous: LockEntry[] } = await syncManifest(
    r.ctx,
    {
      scope: parsed.scope,
      prune: parsed.prune,
      targets,
      ...(persisted ? { persisted } : {}),
      ...(parsed.frozen ? { frozen: true } : {}),
      ...(parsed.secrets ? { secretPolicy: parsed.secrets } : {}),
    },
    r.deps,
  );
  await saveTargetsAfter(r, found, result);
  finishInstall(r, result, targets);
  if (!result.extraneous.length || r.out.jsonMode) return;
  const names = result.extraneous.map((e) => `${e.kind} ${e.name}`).join(', ');
  const n = entries(result.extraneous.length);
  if (parsed.prune) r.out.removed(`${n} not in palm.yaml: ${names}`);
  else
    r.out.warn(`installed but not in palm.yaml: ${names}; remove them with: palm install --prune`);
}

/** Print (or buffer as JSON) the result; exit 1 when the engine reports failures. */
function finishInstall(r: InstallRun, result: InstallResult, targets: TargetId[]): void {
  const { out, parsed } = r;
  if (out.jsonMode) out.json(result);
  else
    printInstallSummary(out, result, {
      scope: parsed.scope,
      targets,
      dryRun: parsed.global.dryRun,
    });
  if (parsed.global.dryRun && !out.jsonMode) out.hint(`\n${DRY_RUN_NOTE}`);
  const failed = failureCount(result);
  if (failed) {
    const saved =
      parsed.global.dryRun || parsed.frozen ? '' : ' (the lockfile records what succeeded)';
    if (!out.jsonMode) out.error(`${failed} failed; see above${saved}`);
    throw new ExitSignal(1);
  }
}

async function buildRequests(r: InstallRun, from: OriginSpec | undefined) {
  const { parsed } = r;
  if (!parsed.adhoc)
    return parsed.specs.map((spec): InstallRequest => ({ kind: parsed.kind, spec, from }));
  const { parseAdhocMcp } = await import('../mcp/adhoc.js');
  const a = parsed.adhoc;
  const adhocMcp = parseAdhocMcp(a.name, {
    command: a.command,
    url: a.url,
    headers: a.headers,
    env: a.env,
    transport: a.transport,
  });
  return [{ kind: 'mcp', spec: a.name, adhocMcp } satisfies InstallRequest];
}

/** Names resolve before targets are asked for, so bad input fails before any prompt. */
async function preflight(r: InstallRun, requests: InstallRequest[]): Promise<void> {
  const { preflightInstall } = await import('../engine/install.js');
  // A kind-less name that matches nothing but is a local directory was meant as an origin.
  const dirs = r.parsed.kind
    ? []
    : requests.filter((q) => typeof q.spec === 'string' && isDirectory(r.ctx, q.spec));
  for (const q of dirs) {
    try {
      await preflightInstall(r.ctx, [q], r.deps);
    } catch (e) {
      throw e instanceof PalmError && e.code === 'E_NOT_FOUND' ? repoRefError(String(q.spec)) : e;
    }
  }
  await preflightInstall(
    r.ctx,
    requests.filter((q) => !dirs.includes(q)),
    r.deps,
  );
}

/** `--from <spec> --save-origin`: register the origin once its entities resolved. */
async function saveFromOrigin(r: InstallRun, from: OriginSpec): Promise<OriginSpec> {
  if (r.ctx.flags.dryRun) {
    r.ctx.log.info(`dry run: would register origin ${from.alias}`);
    return from;
  }
  const { addOrigin } = await import('../core/config.js');
  // Like `palm install origin`: the user's config unless --project, whatever the install scope.
  const saved = await addOrigin(r.ctx, from, { scope: r.parsed.saveOrigin || 'global' });
  r.out.added(`origin ${pc.bold(saved.alias)}`);
  return saved;
}

async function installRequests(
  r: InstallRun,
): Promise<{ result: InstallResult; targets: TargetId[] }> {
  const { parsed } = r;
  let from: OriginSpec | undefined;
  if (parsed.from) {
    const { parseOriginInput } = await import('../core/origin-input.js');
    from = parseOriginInput(parsed.from, { cwd: r.ctx.paths.cwd });
  }
  const requests = await buildRequests(r, from);
  await preflight(r, requests);
  if (from && parsed.saveOrigin) {
    const saved = await saveFromOrigin(r, from);
    for (const q of requests) if (q.from) q.from = saved;
  }
  const found = await findTargetsFor(r);
  const { targets } = found;
  const { persistedTargets } = await import('../engine/resolve-targets.js');
  const lockTargets = await persistedTargets(r.ctx, parsed.scope, found);
  const { installEntities } = await import('../engine/install.js');
  const result = await installEntities(
    r.ctx,
    requests,
    {
      scope: parsed.scope,
      targets,
      secretPolicy: parsed.secrets,
      ...(lockTargets ? { lockTargets } : {}),
    },
    r.deps,
  );
  await saveTargetsAfter(r, found, result);
  return { result, targets };
}

/** What --dry-run does and does not touch (origins are still fetched so the plan is real). */
export const DRY_RUN_NOTE =
  'dry run: no harness files, lockfile or manifest were changed (origins were fetched into the palm cache as needed)';
