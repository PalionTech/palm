/**
 * Generic Target implementation. Each harness supplies a `TargetSpec` (layout.ts): where each
 * kind goes at a scope and how to detect it; deploy and undeploy are shared.
 *
 * A deploy plans first and writes second: the kind planner (planners.ts) fills a `DeployPlan`
 * with whole files and shared-file edits without touching disk, then a `Writer` (plan.ts)
 * checks and applies it in one pass. A failure while writing restores every file the writer
 * touched, merges included, so a failed deploy leaves the scope byte-identical.
 */
import { PalmError } from '../core/errors.js';
import type {
  DeployInput,
  DeployResult,
  Entity,
  LockEntry,
  Scope,
  MergedRecord as StoredMergedRecord,
  Target,
  TargetId,
} from '../core/types.js';
import { type MergedRecord, parseMergedRecord } from '../domain/merged-record.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin, removeEmptyParents } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';
import { removeFileIfExists } from './fs-utils.js';
import { unmergeJsonFile } from './json-merge.js';
import type { CleanupRoot, TargetLayout, TargetSpec } from './layout.js';
import { removeManagedBlock } from './managed-block.js';
import { DeployPlan, Ownership, Writer } from './plan.js';
import { type Job, PLANNERS } from './planners.js';
import { unmergeTomlTable } from './toml-merge.js';

/** Entity names become file and directory names: refuse anything that could leave its directory. */
function assertSafeEntityName(entity: Entity): void {
  if (!isSafeName(entity.name)) {
    throw new PalmError(
      'E_USAGE',
      `refusing to deploy ${entity.kind} "${entity.name}": names may only contain letters, digits, ".", "_" and "-"`,
      'rename it in its origin (or pick another name for an ad hoc MCP server)',
    );
  }
}

/** Remove what one merged record put into its file. */
function unmerge(rec: MergedRecord): Promise<void> {
  switch (rec.type) {
    case 'md-block':
      return removeManagedBlock(rec.file, rec.id);
    case 'toml-table':
      return unmergeTomlTable(rec.file, rec);
    case 'json-item':
    case 'json-key':
      return unmergeJsonFile(rec.file, rec);
  }
}

/** The innermost root strictly containing `abs`. */
function rootOf(roots: readonly CleanupRoot[], abs: string): CleanupRoot | undefined {
  return roots
    .filter((r) => abs !== r.dir && isWithin(abs, r.dir))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/**
 * Files of `entry` inside this target's roots (shared `.palm/hooks` included), pruning emptied
 * dirs. Only the listed files go: a hook's asset directory keeps anything palm did not write
 * there (or a newer install of the same name wrote since).
 */
async function removeOwnFiles(
  entry: LockEntry,
  paths: ScopePaths,
  layout: TargetLayout,
): Promise<void> {
  const roots = [...layout.roots, { dir: paths.hooksDir, stop: paths.palmDir }];
  for (const f of entry.files) {
    const abs = paths.abs(f.path);
    const root = rootOf(roots, abs);
    if (!root) continue;
    await removeFileIfExists(abs);
    await removeEmptyParents(abs, root.stop);
  }
}

/** Unmerge the records in files this target merges into (or writes below). */
async function unmergeOwn(
  merged: readonly StoredMergedRecord[],
  paths: ScopePaths,
  layout: TargetLayout,
): Promise<void> {
  for (const stored of merged) {
    const abs = paths.abs(stored.file);
    const claimed =
      layout.mergedFiles.includes(abs) || layout.roots.some((r) => isWithin(abs, r.dir));
    if (claimed) await unmerge(parseMergedRecord({ ...stored, file: abs }));
  }
}

export class GenericTarget implements Target {
  readonly id: TargetId;
  readonly displayName: string;

  constructor(
    private readonly spec: TargetSpec,
    private readonly boundEnv?: NodeJS.ProcessEnv,
  ) {
    this.id = spec.id;
    this.displayName = spec.displayName;
  }

  /** Paths for a call: its env, else the env bound by createTarget(), else process.env. */
  private paths(scope: Scope, scopeRoot: string, env?: NodeJS.ProcessEnv): ScopePaths {
    return ScopePaths.at(scope, scopeRoot, env ?? this.boundEnv ?? process.env);
  }

  detect(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    return this.spec.detect(ScopePaths.at(scope, scopeRoot, env));
  }

  configDir(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string {
    return this.spec.layout(ScopePaths.at(scope, scopeRoot, env)).configDir;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    assertSafeEntityName(input.entity);
    const paths = this.paths(input.scope, input.scopeRoot, input.env);
    const job: Job = {
      input,
      paths,
      layout: this.spec.layout(paths),
      plan: new DeployPlan(paths),
      owner: new Ownership(input, paths),
      target: { id: this.id, displayName: this.displayName },
    };
    const skipped = await PLANNERS[input.entity.def.kind](job);
    const writer = new Writer(job.plan, job.owner, input.dryRun);
    try {
      await writer.apply();
    } catch (e) {
      await writer.rollback();
      throw e;
    }
    return job.plan.result(skipped);
  }

  /**
   * Remove this target's share of a lock entry (`Target.undeploy(entry, scope, scopeRoot,
   * dryRun, env?)`): the files `entry.files` lists and the records `entry.merged` lists, nothing
   * else. Files outside this target's roots (another target's files) are ignored; missing files
   * are fine. Shared `.agents/skills` and `.palm/hooks` paths are claimed by several targets and
   * removed by whichever runs first.
   */
  async undeploy(...args: Parameters<Target['undeploy']>): Promise<void> {
    const [entry, scope, scopeRoot, dryRun, env] = args;
    if (dryRun) return;
    const paths = this.paths(scope, scopeRoot, env);
    const layout = this.spec.layout(paths);
    await removeOwnFiles(entry, paths, layout);
    await unmergeOwn(entry.merged ?? [], paths, layout);
  }
}
