/**
 * `palm check` (DESIGN §6 "Check"): read-only, runs every check in the documented order and
 * reports each one, with one problem per disagreement and the command that fixes it. Checks
 * that need git are listed as skipped outside a repository. `ok` is false when any check fails;
 * warnings alone keep it true.
 */
import type { CheckReport, CheckRun, EngineDeps, PalmContext, Scope } from '../core/types.js';
import { gitToplevel } from '../lib/fs.js';
import { hiddenUnicode, hookScripts, lockDisk, secrets } from './check-disk.js';
import { type CheckContext, renderAll } from './check-kit.js';
import { execTrusted, localSources, manifestLock, sourcesDeclared } from './check-lock.js';
import { blockSize, doubleLoad, gitIgnored, links } from './check-repo.js';
import { resolveEngineDeps } from './deps.js';
import { runOf } from './jobs.js';
import { openScope } from './scope.js';

type Check = (c: CheckContext) => CheckRun | Promise<CheckRun>;

/** The documented order; `local-sources` runs before `lock-disk` so drifted sources are reported once. */
const ORDER: Array<[string, Check]> = [
  ['manifest-lock', manifestLock],
  ['local-sources', localSources],
  ['lock-disk', lockDisk],
  ['exec-trusted', execTrusted],
  ['hook-scripts', hookScripts],
  ['secrets', secrets],
  ['git-ignored', gitIgnored],
  ['sources-declared', sourcesDeclared],
  ['links', links],
  ['hidden-unicode', hiddenUnicode],
  ['double-load', doubleLoad],
  ['block-size', blockSize],
];

const REPORT_ORDER = [
  'manifest-lock',
  'lock-disk',
  'local-sources',
  'exec-trusted',
  'hook-scripts',
  'secrets',
  'git-ignored',
  'sources-declared',
  'links',
  'hidden-unicode',
  'double-load',
  'block-size',
];

async function inRepository(root: string, scope: Scope): Promise<boolean> {
  if (scope !== 'project') return false;
  return (await gitToplevel(root).catch(() => undefined)) !== undefined;
}

/** DESIGN §6 "Check": every check, read-only; never prompts, never writes. */
export async function checkScope(
  ctx: PalmContext,
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<CheckReport> {
  const deps = await resolveEngineDeps(depsIn);
  const quiet: PalmContext = { ...ctx, flags: { ...ctx.flags, dryRun: true, yes: false } };
  const state = await openScope(quiet, opts.scope, { deps, readOnly: true });
  const run = runOf(quiet, deps, state);
  const c: CheckContext = {
    run,
    git: await inRepository(state.paths.root, opts.scope),
    renders: await renderAll(run),
    driftedSources: new Set(),
  };
  const byId = new Map<string, CheckRun>();
  for (const [id, check] of ORDER) byId.set(id, await check(c));
  const checks = REPORT_ORDER.map((id) => byId.get(id) as CheckRun);
  return { scope: opts.scope, checks, ok: checks.every((r) => r.status !== 'fail') };
}
