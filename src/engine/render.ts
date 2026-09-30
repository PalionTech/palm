/**
 * One entity to its renders (DESIGN §6 step 5): each target's `render` (pure), the content
 * hash, the closure the renders copy, the exec unit, and the refusals: critical scan issues
 * (hidden Unicode, an unresolvable reference, a literal secret from a source) and secret
 * decisions that refuse a destination.
 */
import { join, posix } from 'node:path';
import { commitDate } from '../core/git.js';
import { hashPath, sha256 } from '../core/hash.js';
import type {
  ClosureFile,
  EngineDeps,
  Entity,
  EntityIssue,
  ExecUnit,
  InstallFailure,
  PalmContext,
  Rendered,
  RenderInput,
  SecretPolicy,
  SourceCheckout,
  TargetId,
} from '../core/types.js';
import type { SourceRef } from '../domain/source.js';
import { canonicalJson } from '../lib/json.js';
import { failure, failureOf, installCommand, label, type Subject } from './report.js';
import type { ScopeState } from './scope.js';

export interface RenderJob {
  entity: Entity;
  source: SourceRef;
  checkout: SourceCheckout;
  targets: TargetId[];
  policy: SecretPolicy;
  values?: Record<string, string>;
}

export interface EntityClosure {
  root: string;
  inPlace: boolean;
  files: ClosureFile[];
}

export interface RenderOutput {
  renders: Partial<Record<TargetId, Rendered>>;
  closure: EntityClosure;
  content: string;
  unit?: ExecUnit;
  refusals: InstallFailure[];
  /** Scan warnings (zero-width characters, a literal inside a script) and secret warnings. */
  warnings: string[];
}

interface RenderRun {
  ctx: PalmContext;
  deps: EngineDeps;
  state: ScopeState;
  job: RenderJob;
  subject: Subject;
}

/** The content hash: the entity's files, or a server's canonical config (one file holds many servers). */
export async function contentOf(entity: Entity, checkout: SourceCheckout): Promise<string> {
  if (entity.def.kind === 'mcp') return sha256(canonicalJson(entity.def.mcp));
  return hashPath(join(checkout.root, entity.path), { boundary: checkout.root });
}

/** Lock-form directory of the entity's scripts: `.palm/assets/<source>/<entity>`, or the in-repo source itself. */
export function assetsRootOf(
  state: ScopeState,
  source: SourceRef,
  entity: Entity,
  checkout: SourceCheckout,
): string {
  if (source.isLocal) return state.paths.lockForm(checkout.root);
  return state.paths.assetRoot(source, entity.name);
}

function issueRefusal(run: RenderRun, issue: EntityIssue): InstallFailure {
  const again = installCommand(run.subject, run.state.paths.scope);
  if (issue.code === 'secret-literal')
    return failure(run.subject, 'E_SECRET', {
      message: `${issue.message}; palm never writes a literal secret from a source`,
      hint: `the source must reference an environment variable instead; then run: ${again}`,
    });
  return failure(run.subject, 'E_SOURCE', {
    message: issue.message,
    hint: `fix it in the source (or a fork of it), then run: ${again}`,
  });
}

/** Critical issues refuse the entity (no override); warnings are reported. */
function scanIssues(run: RenderRun): { refusals: InstallFailure[]; warnings: string[] } {
  const issues = run.job.entity.issues ?? [];
  const refusals = issues.filter((i) => i.severity === 'critical').map((i) => issueRefusal(run, i));
  const warnings = issues
    .filter((i) => i.severity === 'warning')
    .map((i) => `${label(run.job.entity)}: ${i.message}`);
  return { refusals, warnings };
}

function renderInput(run: RenderRun, policy: SecretPolicy): RenderInput {
  const { ctx, state, job } = run;
  const inPlace = job.source.isLocal;
  const input: RenderInput = {
    entity: job.entity,
    absPath: join(job.checkout.root, job.entity.path),
    sourceRoot: job.checkout.root,
    source: job.source.source,
    scope: state.paths.scope,
    scopeRoot: state.paths.root,
    assetsRoot: assetsRootOf(state, job.source, job.entity, job.checkout),
    inPlace,
    secretPolicy: policy,
    env: ctx.env,
  };
  if (policy === 'literal' && job.values) input.secretValues = job.values;
  return input;
}

/** The file a server's config lands in for this target (the MCP fragment's file). */
function destinationOf(rendered: Rendered): string | undefined {
  return rendered.fragments[0]?.file ?? rendered.files[0]?.path;
}

/**
 * `--secrets literal` for an MCP server: `decideSecret` per destination (DESIGN §8). `refused`
 * drops the target with a failure; `warn` is reported; an env-ref decision renders again.
 */
async function secretPass(
  run: RenderRun,
  id: TargetId,
  rendered: Rendered,
  out: RenderOutput,
): Promise<Rendered | undefined> {
  const dest = destinationOf(rendered);
  if (run.job.entity.def.kind !== 'mcp' || run.job.policy !== 'literal' || !dest) return rendered;
  const decision = await run.deps.decideSecret({
    scope: run.state.paths.scope,
    fromSource: false,
    requested: 'literal',
    destinationAbs: run.state.paths.abs(dest),
    force: run.ctx.flags.force,
  });
  if (decision.action === 'refused') {
    const hint = installCommand(run.subject, run.state.paths.scope, '--secrets env-ref');
    out.refusals.push(failure(run.subject, 'E_SECRET', { message: decision.reason, hint }, id));
    return undefined;
  }
  if (decision.action === 'warn') out.warnings.push(`${label(run.job.entity)}: ${decision.reason}`);
  if (decision.policy === 'literal') return rendered;
  return run.deps.getTarget(id).render(renderInput(run, 'env-ref'));
}

async function renderTargets(run: RenderRun, out: RenderOutput): Promise<void> {
  if (run.job.entity.kind === 'plugin') return;
  for (const id of run.job.targets) {
    try {
      const first = await run.deps.getTarget(id).render(renderInput(run, run.job.policy));
      const rendered = await secretPass(run, id, first, out);
      if (rendered) out.renders[id] = rendered;
    } catch (e) {
      out.refusals.push(failureOf(run.subject, e, id));
    }
  }
}

/** The closure files the renders write under the entity's asset root (none for in-place sources). */
export function closureOf(
  renders: Partial<Record<TargetId, Rendered>>,
  root: string,
  inPlace: boolean,
): EntityClosure {
  const files = new Map<string, ClosureFile>();
  if (!inPlace)
    for (const r of Object.values(renders))
      for (const f of r?.files ?? []) {
        const rel = posix.relative(root, f.path);
        if (rel.startsWith('..') || rel === '' || posix.isAbsolute(rel)) continue;
        files.set(rel, { path: rel, mode: f.mode ?? 0o644, hash: sha256(f.data) });
      }
  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { root, inPlace, files: sorted };
}

function runsPrograms(entity: Entity): boolean {
  if (entity.def.kind === 'hook') return true;
  return entity.def.kind === 'mcp' && entity.def.mcp.transport === 'stdio';
}

async function unitOf(run: RenderRun, out: RenderOutput): Promise<ExecUnit | undefined> {
  const { entity, checkout } = run.job;
  if (!runsPrograms(entity) || Object.keys(out.renders).length === 0) return undefined;
  const from: ExecUnit['from'] = {};
  if (checkout.sha) {
    from.sha = checkout.sha;
    const date = await commitDate(checkout.repoDir, checkout.sha).catch(() => undefined);
    if (date) from.date = date;
  }
  if (checkout.ref) from.ref = checkout.ref;
  const unit = run.deps.execUnit(entity, out.renders, out.closure, from);
  return unit.commands.length ? unit : undefined;
}

/**
 * Renders one entity for its targets. Nothing is written. A critical scan issue refuses the
 * whole entity; a target that throws or whose secret decision refuses is left out with a
 * failure naming that target.
 */
export async function renderEntity(
  ctx: PalmContext,
  deps: EngineDeps,
  state: ScopeState,
  job: RenderJob,
): Promise<RenderOutput> {
  const subject: Subject = {
    kind: job.entity.kind,
    name: job.entity.name,
    source: job.source.name,
  };
  const run: RenderRun = { ctx, deps, state, job, subject };
  const root = assetsRootOf(state, job.source, job.entity, job.checkout);
  const issues = scanIssues(run);
  const out: RenderOutput = {
    renders: {},
    closure: { root, inPlace: job.source.isLocal, files: [] },
    content: await contentOf(job.entity, job.checkout),
    refusals: issues.refusals,
    warnings: issues.warnings,
  };
  if (out.refusals.length) return out;
  await renderTargets(run, out);
  out.closure = closureOf(out.renders, root, job.source.isLocal);
  const unit = await unitOf(run, out);
  if (unit) out.unit = unit;
  return out;
}
