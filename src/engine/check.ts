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
import { applies, type CheckContext, renderAll } from './check-kit.js';
import { localSources, manifestLock, preloads, sourcesDeclared } from './check-lock.js';
import { agentNames, blockSize, doubleLoad, gitIgnored, links } from './check-repo.js';
import { secrets, variables } from './check-secrets.js';
import { foreignServers } from './check-servers.js';
import { resolveEngineDeps } from './deps.js';
import { runOf } from './jobs.js';
import { openScope } from './scope.js';

type Check = (c: CheckContext) => CheckRun | Promise<CheckRun>;

/**
 * The run order; `local-sources` runs before `lock-disk` so a drifted entry is reported once.
 * The ids after DESIGN §6's twelve are FINDINGS-v2 ruling 29: `render`, `partial`, `orphans`,
 * `pending`, `source-paths` fail; `foreign-hooks`, `foreign-servers` (Sofia S2), `preloads`,
 * `agent-names` only warn.
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
  ['foreign-servers', foreignServers],
  ['hook-scripts', hookScripts],
  ['secrets', secrets],
  ['variables', variables],
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
  'foreign-servers',
  'hook-scripts',
  'secrets',
  'variables',
  'git-ignored',
  'sources-declared',
  'links',
  'hidden-unicode',
  'double-load',
  'agent-names',
  'preloads',
  'block-size',
];

/** Warnings `--strict` fails on: programs in harness files that no lock entry explains (Sofia S2). */
const STRICT_FAILS = new Set(['foreign-hooks', 'foreign-servers']);

/**
 * `--strict` (Sofia S2, O12 X2 B5 E4'): a foreign hook command or stdio server fails, and so
 * does a check that could not run; a check that does not apply to the scope stays skipped.
 */
function strictly(run: CheckRun): CheckRun {
  if (run.status === 'skipped' && applies(run))
    return {
      ...run,
      status: 'fail',
      label: `${run.label}; --strict fails on a check that did not run`,
    };
  if (run.status === 'warn' && STRICT_FAILS.has(run.id)) return { ...run, status: 'fail' };
  return run;
}

async function inRepository(root: string, scope: Scope): Promise<boolean> {
  if (scope !== 'project') return false;
  return (await gitToplevel(root).catch(() => undefined)) !== undefined;
}

/**
 * DESIGN §6 "Check": every check, read-only; never prompts, never writes. `strict` fails on
 * foreign programs and on checks that could not run.
 */
export async function checkScope(
  ctx: PalmContext,
  opts: { scope: Scope; strict?: boolean },
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
  const all = REPORT_ORDER.map((id) => byId.get(id) as CheckRun);
  const checks = opts.strict ? all.map(strictly) : all;
  return { scope: opts.scope, checks, ok: checks.every((r) => r.status !== 'fail') };
}
