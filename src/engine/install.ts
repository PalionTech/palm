/**
 * `installEntities` (DESIGN §6): guard the scope, resolve and expand the requests (plan.ts), ask
 * once before writing anything executable, then deploy item by item (deploy.ts), persisting the
 * lock and manifest after every item so an interruption or crash leaves them consistent.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPalmError, PalmError } from '../core/errors.js';
import type {
  Entity,
  InstallFailure,
  InstallOutcome,
  InstallRequest,
  InstallResult,
  LockEntry,
  PalmContext,
  Scope,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { entityId, isViaKind, lockId } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { OriginSet } from '../domain/origin-set.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import {
  type DeployContext,
  decide,
  deployItem,
  type EngineInstallOptions,
  failureOf,
} from './deploy.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import {
  claimedMcpKeys,
  type EngineRequest,
  expand,
  lookupIndexed,
  notFound,
  type PlanItem,
  planned,
  type ResolveContext,
  resolveRequest,
} from './plan.js';
import { entityDeps, IndexSession } from './query.js';
import { undeploy } from './uninstall.js';

export type { EngineInstallOptions } from './deploy.js';
export type { EngineRequest } from './plan.js';

/**
 * One outcome per kind+name+origin. When an entity shows up twice (installed directly and
 * reached again as a plugin/agent dependency), the more informative outcome wins: anything
 * over a plain `unchanged`, otherwise the first.
 */
export function dedupeOutcomes(outcomes: InstallOutcome[]): InstallOutcome[] {
  const byKey = new Map<string, InstallOutcome>();
  for (const o of outcomes) {
    const key = lockId(o.entry);
    const prev = byKey.get(key);
    if (!prev || (prev.status === 'unchanged' && o.status !== 'unchanged')) byKey.set(key, o);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Scope guards: home as project, project origins
// ---------------------------------------------------------------------------

/**
 * `cwd == $HOME` without a project marker is not a project: palm would write `.claude/` and
 * palm.yaml into the home directory. E_USAGE unless the home holds palm.yaml or `.git`.
 */
export function assertProjectRoot(ctx: PalmContext, scope: Scope): void {
  if (scope !== 'project') return;
  const { projectRoot, home } = ctx.paths;
  if (resolve(projectRoot) !== resolve(home)) return;
  const sp = ScopePaths.of(ctx, 'project');
  if (existsSync(sp.manifestFile) || existsSync(resolve(home, '.git'))) return;
  throw new PalmError(
    'E_USAGE',
    'run inside a project or use -g: the home directory is not a project',
    'cd into a project (a directory with palm.yaml or .git), or install for yourself with -g',
  );
}

/** Project origins: same alias as a user origin must mean the same source; local ones live inside. */
function assertProjectOrigins(ctx: PalmContext): void {
  const [clash] = ctx.origins.conflicts();
  if (clash) {
    throw new PalmError(
      'E_CONFLICT',
      `palm.yaml declares origin "${clash.alias}" as ${clash.project.describe()}, but your origin "${clash.alias}" is ${clash.user.describe()}`,
      `give the project origin another alias in palm.yaml, or rename yours: palm uninstall origin ${clash.alias}, then palm install origin <spec> --alias <name>`,
    );
  }
  const root = ctx.paths.projectRoot;
  for (const o of ctx.origins.projectSpecs()) {
    if (o.type !== 'local' || isWithin(resolve(root, o.path ?? ''), root)) continue;
    throw new PalmError(
      'E_ORIGIN',
      `palm.yaml origin "${o.alias}" points outside the project: ${o.path ?? ''}`,
      `a project's local origins must live inside it; use it just for yourself with: palm install origin ${o.path ?? '<path>'} --alias ${o.alias}`,
    );
  }
}

/** `ctx` with only the user's origins (project origins are ignored under -g). */
function userOriginsOnly(ctx: PalmContext): PalmContext {
  const { origins: _project, ...rest } = Object.getOwnPropertyDescriptors(ctx);
  const copy = Object.defineProperties({}, rest) as PalmContext;
  copy.origins = OriginSet.of(ctx.config.origins);
  return copy;
}

/**
 * The context an operation in `scope` runs with, after the scope guards: the home directory
 * is no project; at project scope, project origins may not shadow user aliases and local ones
 * must live in the project; at global scope, project origins are ignored.
 */
export function scopedContext(ctx: PalmContext, scope: Scope): PalmContext {
  assertProjectRoot(ctx, scope);
  if (scope === 'global') return userOriginsOnly(ctx);
  assertProjectOrigins(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Executable consent
// ---------------------------------------------------------------------------

const COMMAND_KEYS = ['command', 'bash', 'powershell'];

function commandStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(commandStrings);
  if (!isRecord(v)) return [];
  return Object.entries(v).flatMap(([k, x]) =>
    COMMAND_KEYS.includes(k) && typeof x === 'string' ? [x] : commandStrings(x),
  );
}

/** `event → command` lines of a hooks file (Claude, Cursor, Copilot and Gemini shapes). */
function hookLines(raw: unknown): string[] {
  const events = isRecord(raw) && isRecord(raw.hooks) ? raw.hooks : raw;
  if (!isRecord(events)) return [];
  return Object.entries(events).flatMap(([event, v]) =>
    commandStrings(v).map((c) => `${event} → ${c}`),
  );
}

/** What an entity would run on the user's machine: hook commands and stdio MCP servers. */
export function executablesOf(e: Entity): string[] {
  if (e.def.kind === 'hook') {
    const lines = hookLines(e.def.hooks.raw);
    const head = `hook ${e.name} (${e.def.hooks.dialect})`;
    return lines.length ? lines.map((l) => `${head}: ${l}`) : [`${head}: shell commands`];
  }
  if (e.def.kind === 'mcp' && e.def.mcp.transport === 'stdio' && e.def.mcp.command)
    return [`mcp ${e.name}: ${[e.def.mcp.command, ...(e.def.mcp.args ?? [])].join(' ')}`];
  return [];
}

/** Executables among the items this run will actually write (unchanged ones are not asked again). */
async function pendingExecutables(dc: DeployContext, plan: PlanItem[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of plan) {
    if (item.keep || !executablesOf(item.entity).length) continue;
    const d = await decide(dc, item);
    if (d.action === 'deploy' && d.to.length) out.push(...executablesOf(item.entity));
  }
  return out;
}

/**
 * Ask once before writing hooks or stdio MCP servers (PLAN §2.12). Interactive: list them and
 * confirm (default yes; no → E_CANCELLED). Non-interactive: needs --yes (E_NON_INTERACTIVE).
 * --dry-run lists them without asking. Text entities are never gated.
 */
async function askConsent(dc: DeployContext, plan: PlanItem[]): Promise<void> {
  const { ctx } = dc;
  if (dc.opts.consented) return;
  const lines = await pendingExecutables(dc, plan);
  if (!lines.length || (ctx.flags.yes && !ctx.flags.dryRun)) return;
  const n = lines.length;
  ctx.log.info(
    `This install adds ${n === 1 ? 'a command' : `${n} commands`} that run on your machine:`,
  );
  for (const l of lines) ctx.log.info(`  ${l}`);
  if (ctx.flags.dryRun) return;
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `palm will not install ${n === 1 ? 'a command' : `${n} commands`} that run on your machine without your consent`,
      'review them above (or with --dry-run), then rerun with --yes',
    );
  if (!(await ctx.ui.confirm('Install and allow these to run?', true)))
    throw new PalmError('E_CANCELLED', 'Install cancelled; nothing was changed');
}

// ---------------------------------------------------------------------------
// Interruption and persistence
// ---------------------------------------------------------------------------

interface StopState {
  stop: boolean;
}

const running = new Set<StopState>();

/**
 * Ask every running install to stop after its current item (what the SIGINT handler does).
 * The loop persists the lock and manifest and throws E_CANCELLED.
 */
export function requestInstallStop(): void {
  for (const r of running) r.stop = true;
}

function watchInterrupt(ctx: PalmContext): { state: StopState; dispose: () => void } {
  const state: StopState = { stop: false };
  running.add(state);
  const onSigint = (): void => {
    if (state.stop) {
      dispose();
      process.kill(process.pid, 'SIGINT'); // second Ctrl-C: the default handler ends palm now
      return;
    }
    state.stop = true;
    ctx.log.warn('Interrupted: palm stops after the current item (Ctrl-C again to quit now)');
  };
  const dispose = (): void => {
    process.off('SIGINT', onSigint);
    running.delete(state);
  };
  process.on('SIGINT', onSigint);
  return { state, dispose };
}

/** Saves the lock and manifest when they changed since the last save (never in dry run / frozen). */
class Persister {
  private lockText: string;
  private manifestText: string;

  constructor(
    private readonly dc: DeployContext,
    private readonly manifest: Manifest,
  ) {
    this.lockText = JSON.stringify(dc.lock);
    this.manifestText = JSON.stringify(manifest);
  }

  async save(): Promise<void> {
    const { ctx, opts, paths, lock } = this.dc;
    if (ctx.flags.dryRun || opts.frozen) return;
    const lockText = JSON.stringify(lock);
    if (lockText !== this.lockText) {
      await lock.save(paths.lockFile);
      this.lockText = lockText;
    }
    const manifestText = JSON.stringify(this.manifest);
    if (manifestText !== this.manifestText) {
      await this.manifest.save(paths.manifestFile);
      this.manifestText = manifestText;
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution with recorded failures
// ---------------------------------------------------------------------------

/** Errors that end the whole run rather than one request. */
const FATAL = new Set(['E_CANCELLED', 'E_NON_INTERACTIVE', 'E_INTERNAL']);

function recordable(e: unknown, req: EngineRequest, opts: EngineInstallOptions): boolean {
  if (!isPalmError(e) || FATAL.has(e.code)) return false;
  return !!req.locked || !!opts.recordRequestErrors || e.code === 'E_GIT' || e.code === 'E_NETWORK';
}

function requestFailure(req: EngineRequest, e: unknown): InstallFailure {
  if (req.locked) return failureOf(req.locked, e);
  const dep = DepRef.from(req.adhocMcp ? req.adhocMcp.name : req.spec);
  const kind = req.kind ?? (req.registry || req.adhocMcp ? 'mcp' : 'origin');
  return failureOf({ kind, name: dep.name, origin: dep.origin ?? req.from?.alias ?? '' }, e);
}

async function resolveAll(
  rc: ResolveContext,
  requests: EngineRequest[],
  opts: EngineInstallOptions,
  failures: InstallFailure[],
): Promise<PlanItem[]> {
  const direct: PlanItem[] = [];
  for (const req of requests) {
    try {
      direct.push(await resolveRequest(rc, req));
    } catch (e) {
      if (!recordable(e, req, opts)) throw e;
      failures.push(requestFailure(req, e));
    }
  }
  return expand(rc, direct);
}

// ---------------------------------------------------------------------------
// installEntities
// ---------------------------------------------------------------------------

/**
 * Fail fast on names that match nothing, before the CLI asks for targets: throws the same
 * E_NOT_FOUND (with suggestions) or E_ORIGIN that installEntities would. Ad hoc MCP servers
 * and names only the MCP registry may know are left to the engine (no network here), and so
 * is ambiguity (the engine's picker). Git origins come from the index cache, so the engine's
 * own lookup afterwards fetches nothing again.
 */
export async function preflightInstall(
  ctx: PalmContext,
  requests: InstallRequest[],
  depsIn?: Partial<EngineDeps>,
): Promise<void> {
  const deps = await resolveEngineDeps(depsIn);
  // installEntities reads the same origins and repeats their warnings; show them here only on failure.
  const warned: string[] = [];
  const quiet: PalmContext = { ...ctx, log: { ...ctx.log, warn: (msg) => void warned.push(msg) } };
  const session = new IndexSession(quiet, deps.scan);
  try {
    for (const req of requests.map(planned)) {
      if (req.mode !== 'index') continue;
      const l = await lookupIndexed(session, req);
      if (l.cands.length === 0 && !l.registryFallback) throw await notFound(session, req.kind, l);
    }
  } catch (e) {
    for (const msg of warned) ctx.log.warn(msg);
    throw e;
  }
}

/** Removes dependencies a plugin/agent no longer declares (not merely ones that failed to resolve). */
async function dropOrphans(dc: DeployContext, plan: PlanItem[], manifest: Manifest): Promise<void> {
  const { ctx, deps, opts, paths, lock } = dc;
  const orphans: LockEntry[] = [];
  for (const item of plan) {
    if (item.keep || !isViaKind(item.entity.kind)) continue;
    const declared = new Set(entityDeps(item.entity).map(entityId));
    orphans.push(...lock.childrenOf(item.entity).filter((e) => !declared.has(entityId(e))));
  }
  if (!orphans.length) return;
  const removal = lock.planRemoval(orphans, { listed: (e) => manifest.lists(e), checkRoots: true });
  const protect = lock.protectedFiles(paths, removal.removed);
  const report = await undeploy(ctx, deps, {
    scope: opts.scope,
    entries: removal.removed,
    protect,
  });
  dc.failures.push(...report.failures);
  dc.warnings.push(...report.warnings);
  for (const o of removal.removed) {
    if (report.failed.has(lockId(o))) continue;
    lock.remove(o);
    dc.warnings.push(`removed ${o.kind} ${o.name}: no longer part of ${o.via}`);
  }
  lock.reparent(removal.kept);
}

async function deployAll(
  dc: DeployContext,
  plan: PlanItem[],
  manifest: Manifest,
): Promise<InstallOutcome[]> {
  const persister = new Persister(dc, manifest);
  const outcomes: InstallOutcome[] = [];
  const { state, dispose } = watchInterrupt(dc.ctx);
  try {
    for (const item of plan) {
      if (state.stop) throw interrupted(outcomes.length, plan.length);
      const outcome = await deployItem(dc, item);
      outcomes.push(outcome);
      if (item.direct && !dc.opts.noSave && item.manifestDep && outcome.status !== 'failed')
        manifest.addDep(item.entity.kind, item.manifestDep);
      await persister.save();
    }
    if (state.stop) throw interrupted(outcomes.length, plan.length);
    await dropOrphans(dc, plan, manifest);
  } finally {
    dispose();
    await persister.save();
  }
  return outcomes;
}

function interrupted(done: number, total: number): PalmError {
  return new PalmError(
    'E_CANCELLED',
    `Interrupted after ${done} of ${total}; palm.lock.yaml records what was installed`,
    'run the same command again to finish',
  );
}

/**
 * Install entities (DESIGN §6): resolve each request against the origin indexes (or the MCP
 * registry, or the lock's commit), expand composites, ask consent for executables, deploy to
 * every target, and record lock and manifest (direct requests) after each item. Failures of
 * one target, entity or origin are collected in `failures`; the run goes on.
 */
export async function installEntities(
  ctxIn: PalmContext,
  requests: EngineRequest[],
  opts: EngineInstallOptions,
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const ctx = scopedContext(ctxIn, opts.scope);
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const manifest = await Manifest.load(paths.manifestFile);
  const dc: DeployContext = { ctx, deps, opts, paths, lock, warnings: [], failures: [] };
  const rc: ResolveContext = {
    ctx,
    deps,
    session: new IndexSession(ctx, deps.scan),
    lock,
    warnings: dc.warnings,
    scope: opts.scope,
    frozen: !!opts.frozen,
    claimed: claimedMcpKeys(lock),
  };
  const plan = await resolveAll(rc, requests, opts, dc.failures);
  await askConsent(dc, plan);
  const outcomes = await deployAll(dc, plan, manifest);
  return { outcomes, warnings: dc.warnings, failures: dc.failures };
}
