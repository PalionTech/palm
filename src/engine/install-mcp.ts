/**
 * `palm install mcp` (DESIGN §9): servers declared by hand, from flags or a README snippet,
 * recorded under `mcp:` in palm.yaml and rendered like any entity of the pseudo source
 * `manifest`. A literal secret the person typed never reaches palm.yaml: it is written there
 * as `${VAR}`; the harness file gets the reference too, or the literal under
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
} from '../core/types.js';
import { isSafeName } from '../lib/names.js';
import { resolveEngineDeps } from './deps.js';
import { type Job, type Run, runOf } from './jobs.js';
import { lockScope, runJobs } from './runner.js';
import { openScope, type ScopeState, saveScope } from './scope.js';
import { manifestSource, mcpConfigOf, mcpEntity, mcpManifestEntry } from './sources.js';
import { activeTargets, narrowedTargets, refuseLocal, requestTargets } from './targets.js';

interface Literal {
  where: string;
  variable: string;
  value: string;
}

const upperSnake = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

function reference(variable: string): string {
  return `\${${variable}}`;
}

/** The environment variable a header's literal becomes: `DOCS_TOKEN` for Authorization. */
function headerVariable(server: string, header: string): string {
  const suffix = /^authorization$/i.test(header) ? 'TOKEN' : upperSnake(header);
  return `${upperSnake(server)}_${suffix}`;
}

type Scan = (value: string, where: string) => boolean;

/** Env values that are literal secrets become `${KEY}`. */
function envReferences(
  env: Record<string, string>,
  scan: Scan,
  literals: Literal[],
): Record<string, string> {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (!scan(v, `env.${k}`)) continue;
    literals.push({ where: `env.${k}`, variable: k, value: v });
    out[k] = reference(k);
  }
  return out;
}

/** Header values that are literal secrets become `${SERVER_TOKEN}` (keeping a `Bearer ` prefix). */
function headerReferences(
  cfg: McpServerConfig,
  scan: Scan,
  literals: Literal[],
): Record<string, string> {
  const out = { ...cfg.headers };
  for (const [h, v] of Object.entries(cfg.headers ?? {})) {
    if (!scan(v, `headers.${h}`)) continue;
    const variable = headerVariable(cfg.name, h);
    const bearer = /^Bearer\s+(.+)$/i.exec(v);
    literals.push({ where: `headers.${h}`, variable, value: bearer?.[1] ?? v });
    out[h] = bearer ? `Bearer ${reference(variable)}` : reference(variable);
  }
  return out;
}

/** `cfg` with every secret-shaped literal in env and headers replaced by an environment reference. */
function withReferences(
  run: Run,
  cfg: McpServerConfig,
): { cfg: McpServerConfig; literals: Literal[] } {
  const literals: Literal[] = [];
  const scan: Scan = (value, where) => run.deps.scanSecrets(value, where).length > 0;
  const out: McpServerConfig = { ...cfg };
  if (cfg.env) out.env = envReferences(cfg.env, scan, literals);
  if (cfg.headers) out.headers = headerReferences(cfg, scan, literals);
  return { cfg: out, literals };
}

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

function jobOf(run: Run, req: McpRequest): Job {
  const { state } = run;
  const { cfg, literals } = withReferences(run, req.config);
  for (const l of literals)
    if (run.policy !== 'literal')
      run.result.warnings.push(
        `${cfg.name}: ${l.where} held a literal value; written as ${reference(l.variable)}; export ${l.variable} before starting the harness`,
      );
  const entry: McpManifestEntry = {
    ...mcpManifestEntry(cfg),
    ...(req.targets?.length ? { targets: req.targets } : {}),
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
  };
  const narrowed = narrowedTargets(state, targets);
  if (narrowed) job.narrowed = narrowed;
  if (literals.length) job.values = Object.fromEntries(literals.map((l) => [l.variable, l.value]));
  return job;
}

/** The job of a server palm.yaml already declares (bare install); nothing is recorded again. */
export function manifestMcpJob(run: Run, name: string, entry: McpManifestEntry): Job {
  const job = jobOf(run, {
    config: mcpConfigOf(name, entry),
    ...(entry.targets ? { targets: entry.targets } : {}),
  });
  delete job.record;
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
  const state = await openScope(ctx, opts.scope, { deps });
  const run = runOf(ctx, deps, state);
  return lockScope(ctx, state, async () => {
    assertNew(ctx, state, reqs, !!opts.force);
    requestTargets(state);
    try {
      await runJobs(
        run,
        reqs.map((r) => jobOf(run, r)),
      );
    } finally {
      await saveScope(state);
    }
    return run.result;
  });
}
