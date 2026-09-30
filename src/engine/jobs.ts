/**
 * The per-entity pipeline shared by install, bare install, update and migrate, in phases:
 * `prepareJob` renders and diffs (nothing written), `askForConsent` asks once for every exec
 * unit the run would write, then apply.ts writes entity by entity.
 */
import type {
  ConsentRequest,
  EngineDeps,
  Entity,
  EntityRef,
  ExecUnit,
  InstallResult,
  Kind,
  LockEntry,
  ManifestEntry,
  McpManifestEntry,
  PalmContext,
  ScriptReader,
  SecretPolicy,
  SourceCheckout,
  TargetId,
} from '../core/types.js';
import type { RecordState } from '../domain/merged-record.js';
import type { SourceRef } from '../domain/source.js';
import { allowed, checkoutReader } from '../exec/consent.js';
import { needsConsent } from '../exec/trust.js';
import {
  type FileState,
  fileStates,
  fragmentStates,
  type OutcomeDecision,
  outcomeStatus,
} from './diff.js';
import { knownEdits, type Unchecked } from './edits.js';
import { type RenderOutput, renderEntity } from './render.js';
import type { ScopeState } from './scope.js';

/** One run of the engine over a scope: collaborators and the result being filled. */
export interface Run {
  ctx: PalmContext;
  deps: EngineDeps;
  state: ScopeState;
  result: InstallResult;
  policy: SecretPolicy;
  /** Names the consent prompt's header: `This install …` or `This update …`. */
  operation: 'install' | 'update';
  /**
   * `install <source> --all`: programs nobody named are left out without a prompt (declined),
   * unless `--allow-exec` covers them (DESIGN §6 step 6).
   */
  leaveOutPrograms?: boolean;
}

/** One entity to bring onto the disk. */
export interface Job {
  entity: Entity;
  source: SourceRef;
  checkout: SourceCheckout;
  targets: TargetId[];
  /** `plugin:<name>` for a plugin member. */
  via?: string;
  /** Named by the person on this command line: a declined hook asks again. */
  explicit: boolean;
  /** The palm.yaml entry recorded once the entity installed (direct requests only). */
  record?: { kind: Kind; entry: ManifestEntry } | { mcp: McpManifestEntry };
  /** The lock entry's `targets` (narrowed below the scope set). */
  narrowed?: TargetId[];
  at?: string;
  /** Plugin entries: the members they declare. */
  members?: EntityRef[];
  /** Literal secret values the person typed (`install mcp`), used under `--secrets literal`. */
  values?: Record<string, string>;
}

type ConsentState = 'none' | 'trusted' | 'ask' | 'allowed' | 'declined' | 'quiet';

export interface Prepared {
  job: Job;
  previous?: LockEntry;
  out: RenderOutput;
  decision: OutcomeDecision;
  consent: ConsentState;
  /** Set when the kept paths are ones palm could not check (the locked version is unavailable). */
  unchecked?: Unchecked;
}

export function runOf(
  ctx: PalmContext,
  deps: EngineDeps,
  state: ScopeState,
  operation: Run['operation'] = 'install',
): Run {
  const policy = ctx.flags.secrets ?? 'env-ref';
  const result: InstallResult = { outcomes: [], warnings: [], failures: [] };
  return { ctx, deps, state, policy, operation, result };
}

/** Secret values under `--secrets literal` (never in a dry run, which prompts for nothing). */
async function secretValues(run: Run, entity: Entity): Promise<Record<string, string> | undefined> {
  if (entity.def.kind !== 'mcp' || run.policy !== 'literal' || run.ctx.flags.dryRun)
    return undefined;
  const r = await run.deps.resolveSecrets(run.ctx, entity.def.mcp, 'literal');
  return Object.keys(r.values).length ? r.values : undefined;
}

async function diskStates(run: Run, out: RenderOutput) {
  const { paths, applied } = run.state;
  const files = new Map<string, FileState>();
  const fragments = new Map<string, RecordState>();
  for (const r of Object.values(out.renders)) {
    if (!r) continue;
    for (const [k, v] of await fileStates(paths, r, applied ? { applied } : {})) files.set(k, v);
    for (const [k, v] of await fragmentStates(paths, r, run.deps)) fragments.set(k, v);
  }
  return { files, fragments };
}

function consentOf(job: Job, previous: LockEntry | undefined, unit?: ExecUnit): ConsentState {
  if (!unit) return 'none';
  if (previous?.declined) return job.explicit ? 'ask' : 'quiet';
  return needsConsent(previous, unit) ? 'ask' : 'trusted';
}

/** Renders and diffs one job; nothing is written. */
export async function prepareJob(run: Run, job: Job): Promise<Prepared> {
  const previous = run.state.lock.find(job.entity, job.source.name);
  const values =
    run.policy === 'literal' && job.values ? job.values : await secretValues(run, job.entity);
  const out = await renderEntity(run.ctx, run.deps, run.state, {
    entity: job.entity,
    source: job.source,
    checkout: job.checkout,
    targets: job.targets,
    policy: run.policy,
    ...(values ? { values } : {}),
  });
  const { files, fragments } = await diskStates(run, out);
  const check = await knownEdits(run, { previous, out, files, fragments, values });
  const decision = outcomeStatus({
    ...(check ? { edited: check.edited } : {}),
    ...(previous && !previous.declined ? { previous } : {}),
    renders: out.renders,
    files,
    fragments,
    force: run.ctx.flags.force,
    content: out.content,
    local: job.source.isLocal,
  });
  const unchecked = check?.unchecked && decision.kept.length ? check.unchecked : undefined;
  return {
    job,
    ...(previous ? { previous } : {}),
    out,
    decision,
    consent: consentOf(job, previous, out.unit),
    ...(unchecked ? { unchecked } : {}),
  };
}

/** Prompt hooks of the hook sets this run writes: listed as text, never gated. */
function promptHooks(prepared: Prepared[]) {
  return prepared.flatMap(({ job, decision }) =>
    job.entity.def.kind === 'hook' && decision.toWrite.length
      ? job.entity.def.hooks.promptHooks.map((p) => ({ entity: job.entity.name, ...p }))
      : [],
  );
}

/** Script bodies for `v` and `--review`: each unit's closure file at its pinned commit. */
function readerOf(asking: Prepared[]): ScriptReader {
  const checkouts = new Map(asking.map((p) => [(p.out.unit as ExecUnit).key, p.job.checkout]));
  return checkoutReader((unit) => {
    const co = checkouts.get(unit.key);
    return co?.sha ? { checkoutDir: co.repoDir, dirRel: co.source.root ?? '' } : undefined;
  });
}

/** Under `--all`: the programs `--allow-exec` does not cover are declined without a prompt. */
function leaveOut(run: Run, asking: Prepared[]): Prepared[] {
  const allow = run.ctx.flags.allowExec;
  if (!run.leaveOutPrograms || allow === 'all') return asking;
  const kept = asking.filter((p) => allowed(p.out.unit as ExecUnit, allow));
  for (const p of asking) if (!kept.includes(p)) p.consent = 'declined';
  return kept;
}

/**
 * Asks once for every unit that needs consent (DESIGN §7): the lock's trust passes silently,
 * the rest go through `askConsent` (prompt, `--allow-exec`, or E_UNTRUSTED_EXEC without a
 * terminal). A dry run shows the units and asks nothing; they stay undecided, so the dry run
 * reports what an install would write. `--yes` never consents.
 */
export async function askForConsent(
  run: Run,
  prepared: Prepared[],
  previous?: Record<string, ExecUnit>,
): Promise<void> {
  const pending = prepared.filter(
    (p) => p.consent === 'ask' && p.out.unit && !p.out.refusals.some((f) => !f.target),
  );
  const asking = leaveOut(run, pending);
  if (!asking.length) return;
  const req: ConsentRequest = {
    operation: run.operation,
    units: asking.map((p) => p.out.unit as ExecUnit),
    prompts: promptHooks(prepared),
    lockFile: run.state.paths.lockFile,
    read: readerOf(asking),
  };
  const answer = await run.deps.askConsent(run.ctx, previous ? { ...req, previous } : req);
  if (run.ctx.flags.dryRun) return;
  const yes = new Set(answer.allowed);
  for (const p of asking)
    p.consent = yes.has((p.out.unit as ExecUnit).key) ? 'allowed' : 'declined';
}
