/**
 * One entity to its renders (DESIGN §6 step 5): each target's `render` (pure), the content
 * hash, the closure the renders copy (with the files its scripts read, ruling E1; an in-repo
 * closure read in place, ruling E2), the exec unit, and the refusals: critical scan issues
 * (hidden Unicode, an unresolvable reference, a literal secret from a source, a literal in a
 * hook script without `--force`, ruling 28) and secret decisions that refuse a destination.
 */
import { join, posix } from 'node:path';
import { commitDate } from '../core/git.js';
import { hashPath, sha256 } from '../core/hash.js';
import type {
  Closure,
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
import { isTreeExcluded } from '../domain/ignore.js';
import { isSkillCopySkipped } from '../domain/skill-copy.js';
import type { SourceRef } from '../domain/source.js';
import { inPlaceClosure } from '../exec/closure.js';
import { withScriptReads } from '../exec/reads.js';
import { canonicalJson } from '../lib/json.js';
import { failure, failureOf, installCommand, label, type Subject } from './report.js';
import { localPathOf, type ScopeState } from './scope.js';
import { referencedLine, referenceSecrets } from './source-secrets.js';

export interface RenderJob {
  entity: Entity;
  source: SourceRef;
  checkout: SourceCheckout;
  targets: TargetId[];
  policy: SecretPolicy;
  values?: Record<string, string>;
}

interface EntityClosure {
  root: string;
  inPlace: boolean;
  files: ClosureFile[];
  /** In-place closures: the directory the files are read from (the consent viewer, `v`). */
  abs?: string;
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

/** palm's own files at a project root; never part of an entity's content. */
const PALM_FILES = ['palm.yaml', 'palm.lock.yaml', 'palm.local.yaml'];

/**
 * For an in-repo source at the scope root (`.`): what its entities' content leaves out, so a
 * run that writes outputs never moves the content it rendered from (R1, K7): palm's files,
 * the output directories of the active targets, every path the lock lists or merges into, and
 * what a local tree never holds (`isTreeExcluded`). Undefined for any other source.
 */
async function rootSkip(run: RenderRun): Promise<((rel: string) => boolean) | undefined> {
  const { state, job, deps, ctx } = run;
  if (!job.source.isLocal) return undefined;
  const root = (await state.paths.realInside(state.paths.root)).real;
  if (job.checkout.root !== root) return undefined;
  const { lock, paths } = state;
  const dirs = state.targets.flatMap((t) =>
    deps.getTarget(t).outputDirs(paths.scope, paths.root, ctx.env),
  );
  const owned = new Set([
    ...PALM_FILES,
    ...lock.entries.flatMap((e) => [...e.files, ...(e.merged ?? []).map((m) => m.file)]),
  ]);
  const prefix = job.entity.path === '.' ? '' : `${job.entity.path}/`;
  return (rel) => {
    const p = `${prefix}${rel}`;
    return owned.has(p) || isTreeExcluded(p) || dirs.some((d) => p === d || p.startsWith(`${d}/`));
  };
}

/** A skill's content covers the files its copy deploys: the copy skip list at any depth (Y2, R1). */
function skillSkip(entity: Entity): ((rel: string) => boolean) | undefined {
  return entity.kind === 'skill' ? (rel) => isSkillCopySkipped(posix.basename(rel)) : undefined;
}

/** The content hash: the entity's files, or a server's canonical config (one file holds many servers). */
async function contentOf(run: RenderRun): Promise<string> {
  const { entity, checkout } = run.job;
  if (entity.def.kind === 'mcp') {
    const { from: _from, secrets: _secrets, ...server } = entity.def.mcp;
    return sha256(canonicalJson(server));
  }
  const skips = [await rootSkip(run), skillSkip(entity)].filter((s) => s !== undefined);
  const skip = skips.length ? (rel: string) => skips.some((s) => s(rel)) : undefined;
  const abs = join(checkout.root, entity.path);
  return hashPath(abs, { boundary: checkout.root, ...(skip ? { skip } : {}) });
}

/** Lock-form directory of the entity's scripts: `.palm/assets/<source>/<entity>`, or the in-repo source itself. */
function assetsRootOf(
  state: ScopeState,
  source: SourceRef,
  entity: Entity,
  checkout: SourceCheckout,
): string {
  if (source.isLocal) return localPathOf(state, checkout.root);
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

/** Ruling 28: a literal secret in a hook's script (a closure file, not its definition). */
function inHookScript(run: RenderRun, issue: EntityIssue): boolean {
  return (
    run.job.entity.kind === 'hook' &&
    issue.code === 'secret-literal' &&
    issue.severity === 'warning'
  );
}

function scriptSecretRefusal(run: RenderRun, issue: EntityIssue): InstallFailure {
  const again = installCommand(run.subject, run.state.paths.scope, '--force');
  return failure(run.subject, 'E_SECRET', {
    message: `${issue.message}; palm does not install a hook whose script holds a literal secret`,
    hint: `remove it from the script (read it from an environment variable), or review it and run: ${again}`,
  });
}

interface ScanVerdict {
  refusals: InstallFailure[];
  warnings: string[];
  /** Findings the consent review shows under the program (ruling 28, under `--force`). */
  review: string[];
}

/**
 * Critical issues refuse the entity (no override); warnings are reported. A literal in a hook
 * script refuses the hook unless `--force`, and then shows in the consent review (ruling 28).
 */
function scanIssues(run: RenderRun): ScanVerdict {
  const issues = run.job.entity.issues ?? [];
  const force = run.ctx.flags.force;
  const script = issues.filter((i) => inHookScript(run, i));
  const refusals = issues.filter((i) => i.severity === 'critical').map((i) => issueRefusal(run, i));
  if (!force) refusals.push(...script.map((i) => scriptSecretRefusal(run, i)));
  const warnings = issues
    .filter((i) => i.severity === 'warning')
    .map((i) => `${label(run.job.entity)}: ${i.message}`);
  const review = force ? script.map((i) => `literal secret in a script: ${i.message}`) : [];
  return { refusals, warnings, review };
}

/**
 * The render request. Beyond RenderInput it names the entry's active targets (`targets`):
 * shared directories depend on them (cursor writes `.claude/skills` when claude is active).
 */
function renderInput(run: RenderRun, policy: SecretPolicy): RenderInput & { targets: TargetId[] } {
  const { ctx, state, job } = run;
  const inPlace = job.source.isLocal;
  const input: RenderInput & { targets: TargetId[] } = {
    targets: [...job.targets],
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
  if (ctx.flags.force) input.force = true;
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

/** The closure a hook set or a server declares; undefined for other kinds. */
function declaredClosure(entity: Entity): Closure | undefined {
  if (entity.def.kind === 'hook') return entity.def.hooks.closure;
  return entity.def.kind === 'mcp' ? entity.def.closure : undefined;
}

/**
 * The closure: for a git source, the files the renders write under the entity's asset root;
 * for an in-repo source, its closure files as the working tree holds them (ruling E2), read
 * from `abs`.
 */
async function closureOf(run: RenderRun, out: RenderOutput, root: string): Promise<EntityClosure> {
  const { entity, checkout, source } = run.job;
  if (!source.isLocal) return copiedClosure(out.renders, root);
  const declared = declaredClosure(entity);
  const files = declared?.paths.length ? await inPlaceClosure(checkout.root, declared) : [];
  return { root, inPlace: true, files, abs: checkout.root };
}

/** The closure files the renders write under the entity's asset root. */
function copiedClosure(renders: Partial<Record<TargetId, Rendered>>, root: string): EntityClosure {
  const files = new Map<string, ClosureFile>();
  for (const r of Object.values(renders))
    for (const f of r?.files ?? []) {
      const rel = posix.relative(root, f.path);
      if (rel.startsWith('..') || rel === '' || posix.isAbsolute(rel)) continue;
      files.set(rel, {
        path: rel,
        mode: f.mode ?? 0o644,
        size: f.data.byteLength,
        hash: sha256(f.data),
      });
    }
  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { root, inPlace: false, files: sorted };
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
  const referenced = referenceSecrets(job.entity);
  const read = await withScriptReads(referenced.entity, job.checkout.root);
  const run: RenderRun = { ctx, deps, state, job: { ...job, entity: read.entity }, subject };
  const root = assetsRootOf(state, job.source, job.entity, job.checkout);
  const issues = scanIssues(run);
  const harnesses = job.targets.map((t) => deps.getTarget(t).displayName);
  const out: RenderOutput = {
    renders: {},
    closure: { root, inPlace: job.source.isLocal, files: [] },
    content: await contentOf({ ...run, job }),
    refusals: issues.refusals,
    warnings: [
      ...referenced.replaced.map((s) => referencedLine(job.entity.name, s, harnesses)),
      ...issues.warnings,
      ...read.warnings,
    ],
  };
  if (out.refusals.length) return out;
  await renderTargets(run, out);
  out.closure = await closureOf(run, out, root);
  const unit = await unitOf(run, out);
  if (unit && issues.review.length) unit.warnings = issues.review;
  if (unit) out.unit = unit;
  return out;
}
