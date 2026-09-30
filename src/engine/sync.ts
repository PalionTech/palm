/**
 * Bare `palm install` (DESIGN §6 "Bare install"): make the disk match palm.yaml and the lock.
 * Entries in palm.yaml are rendered at the locked sha (a local source re-hashed and re-rendered
 * when its tree changed) and diffed against the lock and the disk; entries the lock lists and
 * palm.yaml no longer does are undeployed, edited files kept. Under -g, files applied.yaml
 * records and the pulled lock dropped are deleted unless edited. The lock is written only when
 * something in it changed, so a clean clone with committed outputs writes nothing.
 */
import { readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256 } from '../core/hash.js';
import type {
  EngineDeps,
  InstallOptions,
  InstallResult,
  Kind,
  LockEntry,
  LockMerged,
  PalmContext,
} from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import type { SourceRef } from '../domain/source.js';
import { removeEmptyParents } from '../lib/fs.js';
import { deepEqual } from '../lib/object.js';
import { resolveEngineDeps } from './deps.js';
import { fragmentKey } from './diff.js';
import { dedupeJobs, manifestJobs } from './entries.js';
import { manifestMcpJob } from './install-mcp.js';
import { askForConsent, type Job, type Run, runOf } from './jobs.js';
import { protectedPaths, sourceRoots, undeploy } from './remove.js';
import { failureOf, palmCommand } from './report.js';
import { lockedSha, lockSourceOf, type Resolved, resolveSource } from './resolve.js';
import { applyAll, lockScope, prepareAll } from './runner.js';
import { openScope, saveScope } from './scope.js';
import { refuseLocal } from './targets.js';
import { editedPaths } from './verify.js';

interface Desired {
  jobs: Job[];
  /** Lock ids palm.yaml still lists but the source no longer has: kept, reported. */
  missing: Set<string>;
  /** Sources that could not be resolved: their entries are left alone. */
  failedSources: Set<string>;
}

async function resolveDeclared(run: Run, ref: SourceRef): Promise<Resolved | undefined> {
  const { ctx, deps, state } = run;
  try {
    const r = await resolveSource({ ctx, deps, state, ref, ...lockedSha(state, ref) });
    const fresh = lockSourceOf(state, ref, r);
    if (!deepEqual(state.lock.source(ref.name), fresh)) state.lock.setSource(ref.name, fresh);
    return r;
  } catch (e) {
    run.result.failures.push(failureOf({ kind: 'source', name: ref.name, source: ref.name }, e));
    return undefined;
  }
}

/** The effective set E: every palm.yaml entry as a job, plus the hand-declared servers. */
async function desired(run: Run): Promise<Desired> {
  const out: Desired = { jobs: [], missing: new Set(), failedSources: new Set() };
  for (const ref of run.state.sources.all()) {
    const r = await resolveDeclared(run, ref);
    if (!r) {
      out.failedSources.add(ref.name);
      continue;
    }
    const m = manifestJobs(run.state, ref, r);
    out.jobs.push(...m.jobs);
    run.result.failures.push(...m.failures);
    for (const id of m.missing) out.missing.add(id);
  }
  for (const [name, entry] of Object.entries(run.state.manifest.mcp))
    out.jobs.push(manifestMcpJob(run, name, entry));
  out.jobs = dedupeJobs(out.jobs);
  return out;
}

function jobId(j: Job): string {
  return lockId({ kind: j.entity.kind, name: j.entity.name, source: j.source.name });
}

/** The entry without what the person changed (or what palm cannot check): those stay on disk. */
async function withoutEdits(run: Run, e: LockEntry): Promise<LockEntry> {
  const edited = run.ctx.flags.force ? [] : await editedPaths(run, e);
  const keep = new Set(edited ?? [...e.files, ...(e.merged ?? []).map(fragmentKey)]);
  const cmd = palmCommand('remove', [e.source, e.name], run.state.paths.scope, '--force');
  for (const p of keep)
    run.result.warnings.push(
      edited
        ? `kept ${p}: you changed it since palm wrote it (${cmd})`
        : `kept ${p}: palm cannot check it against source ${e.source}`,
    );
  const merged = (e.merged ?? []).filter((m) => !keep.has(fragmentKey(m)));
  return { ...e, files: e.files.filter((f) => !keep.has(f)), merged };
}

/** In L, not in E: undeploy by the lock (edited files kept) and drop from the lock. */
async function dropRemoved(run: Run, d: Desired): Promise<void> {
  const { state, ctx, deps } = run;
  const want = new Set(d.jobs.map(jobId));
  const gone = state.lock.entries.filter(
    (e) => !want.has(lockId(e)) && !d.missing.has(lockId(e)) && !d.failedSources.has(e.source),
  );
  const protect = protectedPaths(state.lock, gone);
  const sources = await sourceRoots(state);
  for (const e of gone) {
    const view = await withoutEdits(run, e);
    const report = await undeploy(ctx, deps, {
      paths: state.paths,
      entries: [view],
      protect,
      dryRun: ctx.flags.dryRun,
      sources,
    });
    run.result.failures.push(...report.failures);
    state.lock.remove(e);
    run.result.outcomes.push({ entry: e, status: 'removed', notes: [] });
  }
  for (const name of Object.keys(state.lock.sources))
    if (!state.lock.entriesOf(name).length && !state.manifest.hasSource(name))
      state.lock.removeSource(name);
}

async function diskHash(abs: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(abs));
  } catch {
    return undefined;
  }
}

/** One level below the boundary that holds `abs` (`~/.claude/skills`): pruning stops there. */
function pruneStop(run: Run, abs: string): string | undefined {
  const b = run.state.paths.boundaries().find((d) => !relative(d, abs).startsWith('..'));
  const first = b ? relative(b, abs).split(sep)[0] : undefined;
  return b && first ? join(b, first) : undefined;
}

/** Under -g: a file applied.yaml records that no lock entry lists any more (a pulled removal). */
async function dropUnappliedFile(run: Run, file: { path: string; hash: string }): Promise<void> {
  const disk = await diskHash(file.path);
  if (disk === undefined) return;
  const shown = run.state.paths.lockForm(file.path);
  if (disk !== file.hash && !run.ctx.flags.force) {
    run.result.warnings.push(
      `kept ${shown}: you changed it since palm wrote it; delete it by hand if you no longer need it`,
    );
    return;
  }
  const { inside } = await run.state.paths.realInside(file.path);
  if (!inside || run.ctx.flags.dryRun) return;
  await rm(file.path, { force: true });
  const stop = pruneStop(run, file.path);
  if (stop) await removeEmptyParents(file.path, stop);
  run.ctx.log.info(`removed ${shown}: palm.lock.yaml no longer lists it`);
}

/** The applied fragments no lock entry holds, as entries to undeploy (grouped by their entry id). */
function unappliedFragments(run: Run): LockEntry[] {
  const { state } = run;
  const held = new Set(state.lock.entries.flatMap((e) => (e.merged ?? []).map(fragmentKey)));
  const groups = new Map<string, LockMerged[]>();
  for (const m of state.applied?.merged() ?? []) {
    const merged: LockMerged = {
      file: state.paths.lockForm(m.file),
      at: m.at,
      id: m.id,
      key: m.key,
    };
    if (held.has(fragmentKey(merged))) continue;
    groups.set(m.entry, [...(groups.get(m.entry) ?? []), merged]);
  }
  return [...groups].map(([id, merged]) => {
    const m = /^([a-z]+):(.+)@(.+)$/.exec(id);
    const kind = (m?.[1] ?? 'hook') as Kind;
    return {
      kind,
      name: m?.[2] ?? id,
      source: m?.[3] ?? '',
      path: '',
      content: '',
      render: {},
      files: [],
      merged,
    };
  });
}

async function dropUnapplied(run: Run): Promise<void> {
  const { state, ctx, deps } = run;
  if (!state.applied) return;
  const owned = new Set(state.lock.entries.flatMap((e) => e.files.map((f) => state.paths.abs(f))));
  for (const file of state.applied.record.files)
    if (!owned.has(file.path)) await dropUnappliedFile(run, file);
  const entries = unappliedFragments(run);
  if (!entries.length) return;
  const report = await undeploy(ctx, deps, {
    paths: state.paths,
    entries,
    protect: new Set(),
    dryRun: ctx.flags.dryRun,
  });
  run.result.failures.push(...report.failures);
}

/** DESIGN §6 "Bare install". */
export async function syncScope(
  ctx: PalmContext,
  opts: InstallOptions,
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  refuseLocal(opts);
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps });
  const run = runOf(ctx, deps, state);
  return lockScope(ctx, state, async () => {
    try {
      const d = await desired(run);
      const prepared = await prepareAll(run, d.jobs);
      await askForConsent(run, prepared);
      await dropRemoved(run, d);
      await dropUnapplied(run);
      await applyAll(run, prepared);
    } finally {
      await saveScope(state);
    }
    return run.result;
  });
}
