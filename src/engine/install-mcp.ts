/**
 * `palm install mcp` (DESIGN §9): servers declared by hand, from flags or a README snippet,
 * recorded under `mcp:` in palm.yaml and rendered like any entity of the pseudo source
 * `manifest`. A value the person typed never reaches palm.yaml (`referenceTyped`, J1): it is
 * written there as `${VAR}`; the harness file gets the reference too, or the literal under
 * `--secrets literal` after `decideSecret` allowed that destination (DESIGN §8).
 */
import { PalmError } from '../core/errors.js';
import type {
  EngineDeps,
  InstallOptions,
  InstallResult,
  McpManifestEntry,
  McpRequest,
  McpServerConfig,
  PalmContext,
  SecretPolicy,
} from '../core/types.js';
import { isSafeName } from '../lib/names.js';
import { referenceTyped, type TypedReference, typedLine, typedValues } from '../secrets/typed.js';
import { resolveEngineDeps } from './deps.js';
import { type Job, jobPolicy, type Run, runOf } from './jobs.js';
import { runJobs, settle, withLockedScope } from './runner.js';
import type { ScopeState } from './scope.js';
import { manifestSource, mcpConfigOf, mcpEntity, mcpManifestEntry } from './sources.js';
import { activeTargets, narrowedTargets, refuseLocal, requestTargets } from './targets.js';

function assertNew(ctx: PalmContext, state: ScopeState, reqs: McpRequest[], force: boolean): void {
  for (const { config } of reqs) {
    if (!isSafeName(config.name))
      throw new PalmError(
        'E_USAGE',
        `"${config.name}" is not a valid server name`,
        'use letters, digits, dots, dashes and underscores',
      );
    if (state.manifest.mcp[config.name] && !force && !ctx.flags.force)
      throw new PalmError(
        'E_CONFLICT',
        `mcp server ${config.name} is already in palm.yaml`,
        'to replace it, run',
        {
          retryWith: '--force',
        },
      );
  }
}

/**
 * J1 L3 D7: what the person typed becomes an environment reference (`referenceTyped`); the line
 * per reference names the variable to export. Under `--secrets literal` a typed value is written
 * instead, so only fill-ins and VS Code inputs (which hold no value) are said. The lines print
 * once the server changes on disk, never on an unchanged sync (K17).
 */
function typedNotices(
  cfg: McpServerConfig,
  references: readonly TypedReference[],
  opts: { policy: SecretPolicy; harnesses: string[] },
): string[] {
  const said = opts.policy === 'literal' ? references.filter((r) => r.value === '') : references;
  return said.map((r) => typedLine(cfg.name, r, opts.harnesses));
}

function jobOf(run: Run, req: McpRequest, recorded?: 'literal'): Job {
  const { state } = run;
  const { cfg, references } = referenceTyped(req.config);
  const policy = jobPolicy(run, recorded ? { policy: recorded } : {});
  const harnesses = activeTargets(state, {
    name: cfg.name,
    ...(req.targets ? { targets: req.targets } : {}),
  }).map((t) => run.deps.getTarget(t).displayName);
  const notices = typedNotices(cfg, references, { policy, harnesses });
  const entry: McpManifestEntry = {
    ...mcpManifestEntry(cfg),
    ...(req.targets?.length ? { targets: req.targets } : {}),
    ...(policy === 'literal' ? { secrets: 'literal' as const } : {}),
  };
  const targets = activeTargets(state, {
    name: cfg.name,
    ...(req.targets ? { targets: req.targets } : {}),
  });
  const { ref, checkout } = manifestSource(state);
  const job: Job = {
    entity: mcpEntity(cfg),
    source: ref,
    checkout,
    targets,
    explicit: true,
    record: { mcp: entry },
    policy,
  };
  const narrowed = narrowedTargets(state, targets);
  if (narrowed) job.narrowed = narrowed;
  const values = typedValues(references);
  if (Object.keys(values).length) job.values = values;
  if (notices.length) job.notices = notices;
  return job;
}

/**
 * The job of a server palm.yaml already declares (bare install). Its recorded `secrets:
 * literal` applies (Y19); nothing is recorded again unless `--secrets` on the command line
 * changes the policy, which is then written to the entry.
 */
export function manifestMcpJob(run: Run, name: string, entry: McpManifestEntry): Job {
  const job = jobOf(
    run,
    { config: mcpConfigOf(name, entry), ...(entry.targets ? { targets: entry.targets } : {}) },
    entry.secrets,
  );
  const { secrets: _was, ...rest } = entry;
  const literal = job.policy === 'literal';
  if (literal === (entry.secrets === 'literal')) delete job.record;
  else job.record = { mcp: literal ? { ...rest, secrets: 'literal' } : rest };
  return job;
}

/**
 * DESIGN §9: declares each server under `mcp:` and installs it for the scope's targets. An
 * existing name is E_CONFLICT unless `force`; a stdio server goes through consent.
 */
export async function installMcp(
  ctx: PalmContext,
  reqs: McpRequest[],
  opts: InstallOptions & { force?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  refuseLocal(opts);
  const deps = await resolveEngineDeps(depsIn);
  return withLockedScope(ctx, opts.scope, { deps }, async (state) => {
    const run = runOf(ctx, deps, state);
    assertNew(ctx, state, reqs, !!opts.force);
    requestTargets(state);
    let failed = true;
    try {
      await runJobs(
        run,
        reqs.map((r) => jobOf(run, r)),
      );
      failed = false;
    } finally {
      await settle(run, failed);
    }
    return run.result;
  });
}
