/**
 * `palm check` (DESIGN §6 "Check"): read-only, runs every check in the documented order and
 * reports each one, with one problem per disagreement and the command that fixes it. Checks
 * that could not run (outside a repository, an empty cache offline) are `skipped`, never shown
 * as passed. `ok` is false when any check fails; warnings alone keep it true.
 */
import type { CheckReport, CheckRun, EngineDeps, PalmContext, Scope } from '../core/types.js';
import { gitToplevel } from '../lib/fs.js';
import { hiddenUnicode, lockDisk } from './check-disk.js';
import {
  orphansCheck,
  partialCheck,
  pendingCheck,
  renderCheck,
  sourcePaths,
} from './check-entries.js';
import { execTrusted, foreignHooks, hookScripts } from './check-exec.js';
import { type CheckContext, renderAll } from './check-kit.js';
import { localSources, manifestLock, preloads, sourcesDeclared } from './check-lock.js';
import { agentNames, blockSize, doubleLoad, gitIgnored, links } from './check-repo.js';
import { secrets } from './check-secrets.js';
import { resolveEngineDeps } from './deps.js';
import { runOf } from './jobs.js';
import { openScope } from './scope.js';

type Check = (c: CheckContext) => CheckRun | Promise<CheckRun>;

/**
 * The run order; `local-sources` runs before `lock-disk` so a drifted entry is reported once.
 * The ids after DESIGN §6's twelve are FINDINGS-v2 ruling 29: `render`, `partial`, `orphans`,
 * `pending`, `source-paths` fail; `foreign-hooks`, `preloads`, `agent-names` only warn.
 */
const ORDER: Array<[string, Check]> = [
  ['manifest-lock', manifestLock],
  ['render', renderCheck],
  ['partial', partialCheck],
  ['local-sources', localSources],
  ['lock-disk', lockDisk],
  ['orphans', orphansCheck],
  ['pending', pendingCheck],
  ['source-paths', sourcePaths],
  ['exec-trusted', execTrusted],
  ['foreign-hooks', foreignHooks],
  ['hook-scripts', hookScripts],
  ['secrets', secrets],
  ['git-ignored', gitIgnored],
  ['sources-declared', sourcesDeclared],
  ['links', links],
  ['hidden-unicode', hiddenUnicode],
  ['double-load', doubleLoad],
  ['agent-names', agentNames],
  ['preloads', preloads],
  ['block-size', blockSize],
];

const REPORT_ORDER = [
  'manifest-lock',
  'render',
  'partial',
  'lock-disk',
  'orphans',
  'pending',
  'local-sources',
  'source-paths',
  'exec-trusted',
  'foreign-hooks',
  'hook-scripts',
  'secrets',
  'git-ignored',
  'sources-declared',
  'links',
  'hidden-unicode',
  'double-load',
  'agent-names',
  'preloads',
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
  const offline = new Set<string>();
  const c: CheckContext = {
    run,
    git: await inRepository(state.paths.root, opts.scope),
    renders: await renderAll({ run, offline }),
    offline,
    drifted: new Set(),
  };
  const byId = new Map<string, CheckRun>();
  for (const [id, check] of ORDER) byId.set(id, await check(c));
  const checks = REPORT_ORDER.map((id) => byId.get(id) as CheckRun);
  return { scope: opts.scope, checks, ok: checks.every((r) => r.status !== 'fail') };
}
