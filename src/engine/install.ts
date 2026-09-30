/**
 * `palm install <source> [names…]` (DESIGN §6 "Install with names"), `palm install <source>`
 * without names (list, save nothing) and `palm install mcp` (hand-declared servers, DESIGN §9).
 */
import { PalmError } from '../core/errors.js';
import type {
  EngineDeps,
  Entity,
  InstallOptions,
  InstallRequest,
  InstallResult,
  PalmContext,
  Scope,
  SourceCheckout,
  SourceIndex,
} from '../core/types.js';
import type { SourceRef } from '../domain/source.js';
import { resolveEngineDeps } from './deps.js';
import { dedupeJobs, manifestJobs, requestJobs } from './entries.js';
import { type Job, type Run, runOf } from './jobs.js';
import { palmCommand } from './report.js';
import {
  declareSource,
  lockedSha,
  lockSourceOf,
  matchError,
  matchNames,
  type NameMatch,
  peekSource,
  type Resolved,
  resolveSource,
} from './resolve.js';
import { lockScope, runJobs } from './runner.js';
import { assertNoOverlap, openScope, type ScopeState, saveScope } from './scope.js';
import { refuseLocal, requestTargets } from './targets.js';

export { installMcp } from './install-mcp.js';
export { requestInstallStop } from './runner.js';

/** One info line per agent that mentions skills or servers palm does not install with it. */
function noteMentions(ctx: PalmContext, ref: SourceRef, match: NameMatch, scope: Scope): void {
  for (const e of match.entities) {
    if (e.def.kind !== 'agent') continue;
    const names = [
      ...(e.def.agent.skills ?? []),
      ...(e.def.agent.mcpServers ?? []).map((n) => `mcp:${n}`),
    ];
    if (!names.length) continue;
    const cmd = palmCommand('install', [ref.name, ...names], scope);
    ctx.log.info(
      `agent ${e.name} mentions ${names.join(', ')}; palm installs only what you name: ${cmd}`,
    );
  }
}

function requestedJobs(
  state: ScopeState,
  ref: SourceRef,
  r: Resolved,
  req: InstallRequest & { match: NameMatch },
): Job[] {
  const b = { state, ref, resolved: r };
  const opts = {
    ...(req.targets ? { targets: req.targets } : {}),
    ...(req.at ? { at: req.at } : {}),
  };
  const direct = req.match.entities.flatMap((e: Entity) => requestJobs(b, e, opts));
  const plugins = req.match.plugins.flatMap((p) => requestJobs(b, p.plugin, opts));
  return [...direct, ...plugins];
}

/** When the source moved to another sha, its other entries are rendered from the new one too. */
function movedJobs(state: ScopeState, ref: SourceRef, r: Resolved, run: Run): Job[] {
  const before = state.lock.source(ref.name)?.sha;
  if (!before || before === r.checkout.sha) return [];
  const { jobs, failures } = manifestJobs(state, ref, r);
  run.result.failures.push(...failures);
  return jobs;
}

/** A source left without entries (nothing was installed) leaves palm.yaml and the lock again. */
function forgetEmptySource(state: ScopeState, name: string): void {
  if (state.lock.entriesOf(name).length) return;
  if (!state.manifest.allEntries().some((e) => e.source === name))
    state.manifest.removeSource(name);
  state.lock.removeSource(name);
}

async function install(run: Run, req: InstallRequest, held: { source?: string }): Promise<void> {
  const { ctx, deps, state } = run;
  const scope = state.paths.scope;
  const ref = await declareSource(ctx, state, req.source, {
    ...(req.as ? { as: req.as } : {}),
    yes: ctx.flags.yes,
  });
  held.source = ref.name;
  await assertNoOverlap(ctx, state, deps);
  if (!req.names.length && !req.all)
    throw new PalmError(
      'E_USAGE',
      `name what to install from ${ref.name}`,
      palmCommand('install', [ref.name], scope),
    );
  const r = await resolveSource({ ctx, deps, state, ref, ...lockedSha(state, ref) });
  const match = matchNames(r.index, req.names, !!req.all);
  const err = matchError(ref.name, r.index, match, scope);
  if (err) throw err;
  noteMentions(ctx, ref, match, scope);
  const targets = requestTargets(state, req.targets);
  const jobs = requestedJobs(state, ref, r, { ...req, ...(targets ? { targets } : {}), match });
  state.lock.setSource(ref.name, lockSourceOf(state, ref, r));
  if (req.all) run.leaveOutPrograms = true;
  await runJobs(run, dedupeJobs([...jobs, ...movedJobs(state, ref, r, run)]));
}

/**
 * DESIGN §6 "Install with names": declare the source when new, resolve it (the locked sha
 * while the ref intent is unchanged), match the names, render, ask consent once, apply entity
 * by entity with the lock and palm.yaml saved after each. Names that match nothing throw
 * before anything is written; per-entity and per-target problems are `failures`.
 */
export async function installFromSource(
  ctx: PalmContext,
  req: InstallRequest,
  opts: InstallOptions,
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  refuseLocal(opts);
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps });
  const run = runOf(ctx, deps, state);
  return lockScope(ctx, state, async () => {
    const held: { source?: string } = {};
    try {
      await install(run, req, held);
    } finally {
      if (held.source) forgetEmptySource(state, held.source);
      await saveScope(state);
    }
    return run.result;
  });
}

/** `palm install <source>` without names: fetch and index, save nothing. */
export async function listSource(
  ctx: PalmContext,
  input: string,
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<{ source: SourceRef; checkout: SourceCheckout; index: SourceIndex; declared: boolean }> {
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps, readOnly: true });
  const { ref, declared } = peekSource(ctx, state, input);
  const r = await resolveSource({ ctx, deps, state, ref, ...lockedSha(state, ref) });
  return { source: ref, checkout: r.checkout, index: r.index, declared };
}
