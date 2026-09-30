/**
 * What an update plan says besides its entries: how far a pinned source is behind (`latest
 * v6.4.2`, `main is 063bee9`: D4, C19), why a source counts as a change although no entry
 * changes (`--strict`, D11), programs a source newly ships that nothing installs (V7), and
 * preloads a new agent version adds (K3).
 */
import { defaultBranch, isSemverRange, latestSemverTag, listRemoteRefs } from '../core/git.js';
import type {
  Entity,
  LockSource,
  SourceIndex,
  UpdatePlan,
  UpdatePlanSource,
} from '../core/types.js';
import { entityId } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import type { SourceRef } from '../domain/source.js';
import type { Job, Prepared, Run } from './jobs.js';
import { gapOf, installedNames, preloadLine, preloadsOf } from './preloads.js';
import { palmCommand } from './report.js';
import { type Resolved, rethrowCancel } from './resolve.js';

/**
 * For a tag or sha pin: the newest release tag when the pin is below it, and the default
 * branch's head when it is elsewhere. A range or a branch follows on its own; `--offline` and
 * an unreachable remote say nothing.
 */
export async function describePin(
  run: Run,
  target: SourceRef,
  r: Resolved,
  row: UpdatePlanSource,
): Promise<void> {
  const { url, ref } = target.source;
  if (!url || !ref || isSemverRange(ref) || run.ctx.flags.offline) return;
  try {
    const refs = await listRemoteRefs(url);
    if (refs.heads.includes(ref)) return;
    const latest = latestSemverTag(refs.tags);
    if (latest && refs.tagShas[latest] !== r.checkout.sha) row.latest = latest;
    const branch = (await defaultBranch(url).catch(() => undefined)) ?? refs.heads[0];
    const sha = branch ? refs.headShas[branch] : undefined;
    if (branch && sha && sha !== r.checkout.sha) row.head = { branch, sha };
  } catch (e) {
    rethrowCancel(e);
  }
}

/** D11: a ref edited in palm.yaml that resolves to the locked commit still moves the lock. */
export function refOnlyReason(target: SourceRef, ls: LockSource | undefined): string | undefined {
  const ref = target.source.ref ?? '';
  if (!ls || (ls.ref ?? '') === ref) return undefined;
  const locked = ls.resolved ?? ls.ref ?? '(no ref)';
  return `palm.yaml says ref ${ref || '(none)'}, palm.lock.yaml records ${locked} at the same commit; palm install records the new ref`;
}

function isProgram(e: Entity): boolean {
  if (e.kind === 'hook') return true;
  return e.def.kind === 'mcp' && e.def.mcp.transport === 'stdio';
}

/**
 * V7: hooks and stdio servers the new version ships that nothing installs and the locked
 * version did not have: one `i new program available: …` line each, and `plan.available`.
 */
export function newPrograms(
  run: Run,
  plan: UpdatePlan,
  job: { target: SourceRef; index: SourceIndex; old?: SourceIndex; jobs: Job[] },
): void {
  const { target, index, old } = job;
  const planned = new Set(job.jobs.map((j) => entityId(j.entity)));
  const has = installedNames(run.state.lock.entriesOf(target.name));
  const before = (e: Entity) =>
    old?.entities.some((o) => o.kind === e.kind && sameName(o.name, e.name)) ?? false;
  for (const e of index.entities) {
    if (!isProgram(e) || planned.has(entityId(e)) || has(e.kind, e.name) || before(e)) continue;
    const command = palmCommand('install', [target.name, `${e.kind}:${e.name}`], plan.scope);
    plan.available = [
      ...(plan.available ?? []),
      { kind: e.kind, name: e.name, source: target.name, command },
    ];
    run.ctx.log.info(
      `new program available: ${e.kind} ${e.name} from ${target.name}; see it: ${command} --dry-run`,
    );
  }
}

/**
 * K3: an agent whose new version preloads a skill or server nothing installs prints the preload
 * line; what the locked version preloaded already is not news.
 */
export function newPreloads(
  run: Run,
  p: Prepared,
  indexes: { index: SourceIndex; old?: SourceIndex },
): void {
  const agent = p.job.entity;
  if (agent.kind !== 'agent') return;
  const prior = indexes.old?.entities.find(
    (e) => e.kind === 'agent' && sameName(e.name, agent.name),
  );
  const key = (kind: string, name: string) => `${kind}:${name.toLowerCase()}`;
  const had = new Set(prior ? preloadsOf(prior).map((x) => key(x.kind, x.name)) : []);
  const lockHas = installedNames(run.state.lock.entries);
  const has = (kind: Entity['kind'], name: string) =>
    lockHas(kind, name) || had.has(key(kind, name));
  const gap = gapOf(run, { agent, source: p.job.source.name, index: indexes.index }, has);
  if (gap) run.ctx.log.info(preloadLine(gap));
}
