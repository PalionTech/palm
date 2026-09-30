/**
 * Everything `palm migrate` decides before it writes (DESIGN §6 "Migrate"): the scope opened on
 * the converted palm.yaml and provisional lock without touching the 0.1 files, the scope guards
 * and the overlap rule, every source resolved at its locked commit, 0.1 entries renamed to the
 * 0.2 names by path, the jobs of a bare install prepared, and the one consent. A failure here
 * leaves the 0.1 files as they were, so the printed `--allow-exec` line can run the same
 * command again.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isPalmError, PalmError } from '../core/errors.js';
import type {
  EngineDeps,
  InstallFailure,
  Kind,
  LockEntry,
  PalmContext,
  Scope,
} from '../core/types.js';
import { Applied } from '../domain/applied.js';
import { sameName } from '../domain/entity-ref.js';
import type { Lock } from '../domain/lock.js';
import type { Manifest } from '../domain/manifest.js';
import { LOCK_FILE, MANIFEST_FILE, ScopePaths } from '../domain/scope-paths.js';
import type { SourceRef } from '../domain/source.js';
import { dedupeJobs, manifestJobs } from './entries.js';
import { manifestMcpJob } from './install-mcp.js';
import { askForConsent, type Job, type Prepared, type Run, runOf } from './jobs.js';
import type { LegacyItem } from './migrate-legacy.js';
import { lockSourceOf, pinOf, type Resolved, resolveSource } from './resolve.js';
import { prepareAll } from './runner.js';
import { assertNoOverlap, openScope, type ScopeState } from './scope.js';
import { detectTargets } from './targets.js';

/** A 0.1 entry palm 0.2 names differently (a root hook is named after its folder, not the alias). */
interface Rename {
  kind: Kind;
  source: string;
  from: string;
  to: string;
}

export interface Plan {
  run: Run;
  prepared: Prepared[];
  renamed: Rename[];
  /** Absolute path → the hash 0.1 recorded, for every file the provisional lock adopted. */
  hashes: Map<string, string>;
}

export interface PlanInput {
  manifest: Manifest;
  lock: Lock;
  /** Absolute path → the hash 0.1 recorded, for every file the provisional lock adopted. */
  hashes: Map<string, string>;
  legacy: LegacyItem[];
}

// ---------------------------------------------------------------------------
// The scope, opened without writing
// ---------------------------------------------------------------------------

function isLegacyFormat(e: unknown): boolean {
  return isPalmError(e) && e.code === 'E_USAGE' && e.hint === 'palm migrate';
}

/** The scope guards openScope applies before it reads palm.yaml (it then stops on the 0.1 file). */
async function assertGuards(ctx: PalmContext, scope: Scope): Promise<void> {
  try {
    await openScope(ctx, scope, { readOnly: true });
  } catch (e) {
    if (!isLegacyFormat(e)) throw e;
  }
}

/**
 * The scope opened on `input` without writing to it: palm.yaml and the lock are written to a
 * temporary directory, opened there, and the state then points at the scope's real paths
 * (sources, targets and the overlap rule are computed again for them).
 */
async function openStaged(
  ctx: PalmContext,
  scope: Scope,
  input: { text: string; lock: Lock },
  deps: EngineDeps,
): Promise<ScopeState> {
  await assertGuards(ctx, scope);
  const dir = await mkdtemp(join(tmpdir(), 'palm-migrate-'));
  let state: ScopeState;
  try {
    await writeFile(join(dir, MANIFEST_FILE), input.text);
    await input.lock.save(join(dir, LOCK_FILE));
    const at = scope === 'project' ? { projectRoot: dir } : { palmHome: dir };
    state = await openScope({ ...ctx, paths: { ...ctx.paths, ...at } }, scope, { readOnly: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const paths = ScopePaths.of(ctx, scope);
  const label = scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  state.paths = paths;
  state.sources = state.manifest.sources(dirname(paths.manifestFile), label);
  state.targets = state.manifest.targets ?? (await detectTargets(ctx, paths, deps));
  delete state.applied;
  await assertNoOverlap(ctx, state, deps);
  return state;
}

// ---------------------------------------------------------------------------
// 0.1 names → 0.2 names, by the entity's path in its source
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function renamedEntry(e: LockEntry, to: string): LockEntry {
  const merged = e.merged?.map((m) => ({
    ...m,
    id: m.id.replace(`palm:${e.kind}:${e.name}:`, `palm:${e.kind}:${to}:`),
  }));
  return { ...e, name: to, ...(merged ? { merged } : {}) };
}

/**
 * The 0.1 entries of `ref` its index has under another name, renamed in palm.yaml and the lock
 * (matched by kind and path; palm 0.1 named a root `hooks/hooks.json` after the alias).
 */
function renameByPath(state: ScopeState, ref: SourceRef, r: Resolved, legacy: LegacyItem[]) {
  const renamed: Rename[] = [];
  for (const item of legacy.filter((i) => i.source === ref.name)) {
    const { kind } = item;
    const from = item.entry.name;
    if (r.index.entities.some((e) => e.kind === kind && sameName(e.name, from))) continue;
    const found = r.index.entities.find(
      (e) => e.kind === kind && samePath(e.path, item.entry.path),
    );
    const current = state.lock.find({ kind, name: from }, ref.name);
    if (!found || !current) continue;
    state.lock.remove(current).upsert(renamedEntry(current, found.name));
    const entry = state.manifest.entries(ref.name, kind).find((e) => sameName(e.name, from));
    if (entry) {
      state.manifest.addEntry(ref.name, kind, { ...entry, name: found.name });
      state.manifest.removeEntry(ref.name, kind, from);
    }
    renamed.push({ kind, source: ref.name, from, to: found.name });
  }
  return renamed;
}

// ---------------------------------------------------------------------------
// The bare install's jobs
// ---------------------------------------------------------------------------

/** A source that cannot be resolved stops the migration before anything is written. */
function unresolved(ref: SourceRef, e: unknown): PalmError {
  const why = e instanceof Error ? e.message : String(e);
  const hint = isPalmError(e) && e.hint ? e.hint : 'palm migrate --dry-run';
  return new PalmError(
    isPalmError(e) ? e.code : 'E_SOURCE',
    `source ${ref.name}: ${why}; nothing was migrated`,
    hint,
  );
}

async function jobsOf(
  run: Run,
  legacy: LegacyItem[],
): Promise<{ jobs: Job[]; renamed: Rename[]; failures: InstallFailure[] }> {
  const { ctx, deps, state } = run;
  const out = { jobs: [] as Job[], renamed: [] as Rename[], failures: [] as InstallFailure[] };
  for (const ref of state.sources.all()) {
    const r = await resolveSource({ ctx, deps, state, ref, ...pinOf(state, ref) }).catch(
      (e: unknown) => {
        throw unresolved(ref, e);
      },
    );
    state.lock.setSource(ref.name, lockSourceOf(state, ref, r));
    out.renamed.push(...renameByPath(state, ref, r, legacy));
    const m = manifestJobs(state, ref, r);
    out.jobs.push(...m.jobs);
    out.failures.push(...m.failures);
  }
  for (const [name, entry] of Object.entries(state.manifest.mcp))
    out.jobs.push(manifestMcpJob(run, name, entry));
  return { ...out, jobs: dedupeJobs(out.jobs) };
}

/**
 * 0.1 entries no job installs (an entry the source no longer has): dropped from the provisional
 * lock with their files left where they are, so the install never deletes them.
 */
function dropUnlisted(run: Run, jobs: Job[]): void {
  const want = new Set(jobs.map((j) => `${j.entity.kind}:${j.entity.name}@${j.source.name}`));
  for (const e of run.state.lock.entries) {
    if (want.has(`${e.kind}:${e.name}@${e.source}`) || Object.keys(e.render).length) continue;
    run.state.lock.remove(e);
    const files = e.files.length + (e.merged?.length ?? 0);
    if (files)
      run.result.warnings.push(
        `kept what palm 0.1 wrote for ${e.kind} ${e.name} (${files} ${files === 1 ? 'path' : 'paths'}): palm 0.2 does not install it from ${e.source}`,
      );
  }
}

/** A declined program stops the migration: palm 0.1's copy of it would stay half moved. */
function refuseDeclined(prepared: Prepared[]): void {
  const declined = prepared.filter((p) => p.consent === 'declined' && p.out.unit);
  if (!declined.length) return;
  throw new PalmError(
    'E_CANCELLED',
    `you declined ${declined.length === 1 ? '1 program' : `${declined.length} programs`}; nothing was migrated`,
    'palm migrate --dry-run --review shows every program and its scripts',
  );
}

/**
 * DESIGN §6 "Migrate", up to the consent: nothing is written. In a dry run the consent only
 * shows the programs (and, with `--review`, their scripts).
 */
export async function planMigration(
  ctx: PalmContext,
  scope: Scope,
  input: PlanInput & { text: string },
  deps: EngineDeps,
): Promise<Plan> {
  const state = await openStaged(ctx, scope, input, deps);
  if (scope === 'global') state.applied = Applied.fromLock(input.lock, state.paths, input.hashes);
  const run = runOf(ctx, deps, state);
  const { jobs, renamed, failures } = await jobsOf(run, input.legacy);
  run.result.failures.push(...failures);
  dropUnlisted(run, jobs);
  const { prepared } = await prepareAll(run, jobs);
  await askForConsent(run, prepared);
  refuseDeclined(prepared);
  return { run, prepared, renamed, hashes: input.hashes };
}
