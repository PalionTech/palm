/**
 * Generic Target implementation. Each harness supplies a `TargetSpec` (layout.ts): where each
 * kind goes at a scope and how to detect it; rendering, applying and undeploying are shared.
 *
 * - `render()` is pure: the kind renderer (render.ts) reads the source and the closure, never
 *   the destination, and returns every file and fragment with the render hash.
 * - `apply()` writes a render through the Applier (apply.ts): collisions first, then a
 *   journaled transaction that rolls back on failure.
 * - `undeploy()` removes exactly the lock entry's files inside this target's roots and the
 *   assets dir, pruning emptied directories, and unmerges its fragments by (at, key).
 */
import { PalmError } from '../core/errors.js';
import type {
  ApplyInput,
  ApplyResult,
  Entity,
  LockEntry,
  LockMerged,
  Rendered,
  RenderInput,
  Scope,
  Target,
  TargetId,
} from '../core/types.js';
import { type MergedRecord, parseMergedRecord } from '../domain/merged-record.js';
import { homeOf, palmHomeOf, ScopePaths } from '../domain/scope-paths.js';
import { isWithin, pathExists, removeEmptyParents } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';
import { isRecord } from '../lib/object.js';
import { type AgentNameClash, agentNameClashes } from './agent-names.js';
import { Applier } from './apply.js';
import { readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { unmergeJsonFile } from './json-merge.js';
import type { CleanupRoot, TargetLayout, TargetSpec } from './layout.js';
import { removeManagedBlock } from './managed-block.js';
import { type Placement, placements } from './placements.js';
import { RENDERERS, RenderJob } from './render.js';
import { unmergeTomlTable } from './toml-merge.js';

/** Entity names become file and directory names: refuse anything that could leave its directory. */
function assertSafeEntityName(entity: Entity): void {
  if (!isSafeName(entity.name)) {
    throw new PalmError(
      'E_USAGE',
      `refusing to install ${entity.kind} "${entity.name}": names may only contain letters, digits, ".", "_" and "-"`,
      'rename it in its source (or pick another name for an MCP server)',
    );
  }
}

/** The scope a render was made for: token paths (`<claude>/…`) are global. */
function scopeOfRender(rendered: Rendered): Scope {
  const paths = [...rendered.files.map((f) => f.path), ...rendered.fragments.map((f) => f.file)];
  return paths.some((p) => p.startsWith('<')) ? 'global' : 'project';
}

/** Remove what one fragment put into its file, found by key. */
function unmerge(rec: MergedRecord): Promise<void> {
  switch (rec.type) {
    case 'md-block':
      return removeManagedBlock(rec.file, rec.key);
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

async function assertDeletable(paths: ScopePaths, abs: string, shown: string): Promise<void> {
  const r = await paths.realInside(abs);
  if (!r.inside)
    throw new PalmError(
      'E_IO',
      `refusing to delete ${shown}: it resolves to ${r.real}, outside ${paths.root}`,
      `ls -l ${abs}`,
    );
}

/**
 * Files of `entry` inside this target's roots and the assets dir, pruning emptied dirs. Only the
 * listed files go: an asset directory keeps anything palm did not write there.
 */
async function removeOwnFiles(
  entry: LockEntry,
  paths: ScopePaths,
  layout: TargetLayout,
): Promise<void> {
  const roots = [...layout.roots, { dir: paths.assetsDir, stop: paths.assetsDir }];
  const doomed: Array<{ abs: string; root: CleanupRoot }> = [];
  for (const f of entry.files) {
    const abs = paths.abs(f);
    const root = rootOf(roots, abs);
    if (!root) continue;
    await assertDeletable(paths, abs, f);
    doomed.push({ abs, root });
  }
  for (const { abs, root } of doomed) {
    await removeFileIfExists(abs);
    await removeEmptyParents(abs, root.stop);
  }
}

/** Unmerge the fragments in files this target merges into (or writes below). */
async function unmergeOwn(
  merged: readonly LockMerged[],
  paths: ScopePaths,
  layout: TargetLayout,
): Promise<void> {
  const created = new Set<string>();
  for (const m of merged) {
    const abs = paths.abs(m.file);
    const claimed =
      layout.mergedFiles.includes(abs) || layout.roots.some((r) => isWithin(abs, r.dir));
    if (!claimed) continue;
    await assertDeletable(paths, abs, m.file);
    const { created: made, ...record } = m;
    await unmerge(parseMergedRecord({ ...record, file: abs, value: undefined }));
    if (made) created.add(abs);
  }
  for (const abs of created) await removeIfOnlyEnsured(abs);
}

/** Keys palm sets on a shared file it creates (`RenderedFragment.ensure`: Cursor's `version`). */
const ENSURED_KEYS: ReadonlySet<string> = new Set(['version']);

/**
 * A JSON file palm created that holds nothing but the keys palm ensured is palm's leftover
 * (`{"version": 1}` after the last Cursor hook left, ruling J14): removed.
 */
async function removeIfOnlyEnsured(abs: string): Promise<void> {
  const text = await readTextOrUndefined(abs);
  if (text === undefined || !abs.endsWith('.json')) return;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return;
  }
  if (isRecord(doc) && Object.keys(doc).every((k) => ENSURED_KEYS.has(k)))
    await removeFileIfExists(abs);
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
    const e = env ?? this.boundEnv ?? process.env;
    const home = scope === 'global' ? scopeRoot : homeOf(e);
    return new ScopePaths(scope, scopeRoot, palmHomeOf(e, home), e);
  }

  async detect(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    return (await this.evidence(scope, scopeRoot, env)) !== undefined;
  }

  /** The absolute path that marks the harness in use at the scope (`.codex`, `CLAUDE.md`), if any. */
  async evidence(
    scope: Scope,
    scopeRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | undefined> {
    for (const marker of this.spec.markers(this.paths(scope, scopeRoot, env)))
      if (await pathExists(marker)) return marker;
    return undefined;
  }

  /** Agent files of this harness's agents directory that answer to one name, lock form (Y14). */
  async agentNameClashes(
    scope: Scope,
    scopeRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<AgentNameClash[]> {
    const paths = this.paths(scope, scopeRoot, env);
    const clashes = await agentNameClashes(this.spec.layout(paths).agentsDir);
    return clashes.map((c) => ({ name: c.name, files: c.files.map((f) => paths.lockForm(f)) }));
  }

  configDir(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string {
    return this.spec.layout(this.paths(scope, scopeRoot, env)).configDir;
  }

  outputDirs(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string[] {
    return this.spec.outputDirs(this.paths(scope, scopeRoot, env));
  }

  placements(
    at: { scope: Scope; scopeRoot: string; env: NodeJS.ProcessEnv },
    active: readonly TargetId[],
  ): Placement[] {
    const paths = this.paths(at.scope, at.scopeRoot, at.env);
    return placements(paths, this.spec.layout(paths), { id: this.id, active });
  }

  async render(input: RenderInput): Promise<Rendered> {
    assertSafeEntityName(input.entity);
    const paths = this.paths(input.scope, input.scopeRoot, input.env);
    const target = { id: this.id, displayName: this.displayName };
    const job = new RenderJob(input, paths, this.spec.layout(paths), target);
    await RENDERERS[input.entity.def.kind](job);
    return job.finish();
  }

  apply(input: ApplyInput): Promise<ApplyResult> {
    const scope = input.scope ?? scopeOfRender(input.rendered);
    return new Applier(this.paths(scope, input.scopeRoot, input.env), input).run();
  }

  /**
   * Remove this target's share of a lock entry: the files `entry.files` lists and the fragments
   * `entry.merged` lists, nothing else. Files outside this target's roots (another target's
   * files) are ignored; missing files are fine. Shared `.agents/skills` and `.palm/assets` paths
   * are claimed by several targets and removed by whichever runs first.
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
