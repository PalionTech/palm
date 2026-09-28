/**
 * Generic Target implementation. Each harness supplies a `TargetSpec`: where each kind goes
 * at a scope (`TargetLayout`) and how to detect it; deploy/undeploy logic is shared.
 *
 * A deploy has two halves. The kind handlers fill a `DeployPlan` (files to write with their
 * content, merged records, notes; no IO), and a `Writer` applies the plan's file writes under
 * the collision policy, rolling back the files it created when a later step fails. Merges
 * into shared files (JSON, TOML, AGENTS.md blocks) are still applied by the handlers as
 * they go; moving them into the plan is the next step.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import type {
  DeployInput,
  DeployResult,
  Entity,
  HookSet,
  LockEntry,
  Scope,
  MergedRecord as StoredMergedRecord,
  Target,
  TargetId,
} from '../core/types.js';
import { HOOK_ASSET_SKIP_FILE, HOOK_ASSET_SKIP_TOP } from '../domain/ignore.js';
import {
  blockPointer,
  type MergedRecord,
  parseMergedRecord,
  toStored,
} from '../domain/merged-record.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin, pathExists, removeEmptyParents } from '../lib/fs.js';
import { stringifyJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { isSafeName } from '../lib/names.js';
import { renderAgent } from './convert-agent.js';
import { renderCommand } from './convert-command.js';
import { convertHooks, referencesPluginRoot } from './convert-hooks.js';
import { renderInstruction } from './convert-instruction.js';
import {
  atomicWrite,
  ensureMode,
  listCopyFiles,
  readFileOrUndefined,
  removeDirIfExists,
  removeFileIfExists,
} from './fs-utils.js';
import { appendJsonItem, ensureJsonKey, setJsonKey, unmergeJsonFile } from './json-merge.js';
import { removeManagedBlock, upsertManagedBlock } from './managed-block.js';
import { renderMcp } from './mcp-config.js';
import { redactSecrets } from './recorded.js';
import { mergeTomlTable, unmergeTomlTable } from './toml-merge.js';

export interface CleanupRoot {
  /** Directory this target writes into. */
  dir: string;
  /** Directory never removed when pruning empty parents (e.g. `.claude`, `.github`). */
  stop: string;
}

export interface TargetLayout {
  /** Config dir reported by configDir(). */
  configDir: string;
  /** Directory holding `<name>/` skill directories. */
  skillsDir: string;
  agentsDir: string;
  instructions: { dir: string } | { agentsMd: string } | { skip: string };
  commands: { dir: string } | { skip: string };
  /** Merge into a shared hooks file, or write a standalone `<name>.json` into `dir`. */
  hooks: { mergeFile: string; versioned?: boolean } | { dir: string };
  /** MCP servers: keys of the JSON object at `path`, or `[mcp_servers.<name>]` TOML tables. */
  mcp: { json: string; path: string[] } | { toml: string };
  /** Directories this target writes files into (claims them at undeploy). */
  roots: CleanupRoot[];
  /** Shared files outside `roots` this target merges into. */
  mergedFiles: string[];
}

export interface TargetSpec {
  id: TargetId;
  displayName: string;
  layout(paths: ScopePaths): TargetLayout;
  detect(paths: ScopePaths): Promise<boolean>;
}

type OnConflict = 'overwrite' | 'error';

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

interface PlannedWrite {
  abs: string;
  data: Buffer;
  mode?: number;
}

type CheckedWrite = PlannedWrite & { exists: boolean };

/** What one deploy produces: files to write, merged records and notes. Bookkeeping only, no IO. */
class DeployPlan {
  /** Writes not yet applied by the Writer. */
  readonly writes: PlannedWrite[] = [];
  /** Deployed files, lock form. */
  readonly files: string[] = [];
  /** Merged records, lock form. */
  readonly merged: StoredMergedRecord[] = [];
  readonly notes: string[] = [];

  constructor(readonly paths: ScopePaths) {}

  note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  write(abs: string, data: string | Buffer, mode?: number): void {
    this.writes.push({
      abs,
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mode,
    });
  }

  addFile(abs: string): void {
    const f = this.paths.lockForm(abs);
    if (!this.files.includes(f)) this.files.push(f);
  }

  addMerged(rec: MergedRecord): void {
    this.merged.push(toStored({ ...rec, file: this.paths.lockForm(rec.file) }));
  }

  result(skipped?: boolean): DeployResult {
    return {
      files: this.files,
      merged: this.merged,
      notes: this.notes,
      ...(skipped ? { skipped: true } : {}),
    };
  }
}

/**
 * Applies a plan's writes under the collision policy: identical content is a no-op, a
 * foreign different file is E_CONFLICT unless forced or owned by the entity. Remembers the
 * files it created so a failed deploy leaves nothing untracked behind.
 */
class Writer {
  private readonly owned: Set<string>;
  private readonly created: string[] = [];
  private checked?: CheckedWrite[];

  constructor(
    private readonly input: DeployInput,
    private readonly plan: DeployPlan,
  ) {
    this.owned = new Set(input.ownedFiles.map((f) => this.ownedKey(f)));
  }

  /** ownedFiles entries may be `file` or `file#pointer` (merged entries). */
  private ownedKey(f: string): string {
    const hash = f.indexOf('#');
    const { paths } = this.plan;
    return hash < 0 ? paths.abs(f) : `${paths.abs(f.slice(0, hash))}#${f.slice(hash + 1)}`;
  }

  private isOwned(abs: string, pointer?: string): boolean {
    return this.owned.has(abs) || (pointer !== undefined && this.owned.has(`${abs}#${pointer}`));
  }

  /** Conflict mode for a merged entry: overwrite when forced or owned (file or file#pointer). */
  onConflict(abs: string, pointer: string): OnConflict {
    return this.input.force || this.isOwned(abs, pointer) ? 'overwrite' : 'error';
  }

  private async checkOne(w: PlannedWrite): Promise<CheckedWrite> {
    const shown = this.plan.paths.lockForm(w.abs);
    let existing: Buffer | undefined;
    try {
      existing = await readFileOrUndefined(w.abs);
    } catch {
      throw new PalmError(
        'E_CONFLICT',
        `refusing to overwrite ${shown} (not a regular file)`,
        'move it aside and retry',
      );
    }
    if (existing?.equals(w.data)) return { ...w, exists: true };
    if (existing && !this.input.force && !this.isOwned(w.abs))
      throw new PalmError('E_CONFLICT', `refusing to overwrite ${shown}`, 'rerun with --force');
    return { ...w, exists: false };
  }

  private async checkAll(): Promise<CheckedWrite[]> {
    const out: CheckedWrite[] = [];
    for (const w of this.plan.writes) out.push(await this.checkOne(w));
    return out;
  }

  /** Check every planned write against the collision policy before anything is written. */
  async check(): Promise<void> {
    this.checked = await this.checkAll();
  }

  private async apply(w: CheckedWrite): Promise<void> {
    if (w.exists) {
      if (w.mode !== undefined) await ensureMode(w.abs, w.mode);
      return;
    }
    const existed = await pathExists(w.abs);
    await atomicWrite(w.abs, w.data, w.mode);
    if (!existed) this.created.push(w.abs);
  }

  /** Perform the planned writes (checked first); identical files only get their mode fixed. */
  async flush(): Promise<void> {
    const writes = this.checked ?? (await this.checkAll());
    for (const w of writes) {
      if (!this.input.dryRun) await this.apply(w);
      this.plan.addFile(w.abs);
    }
    this.plan.writes.length = 0;
    this.checked = undefined;
  }

  /** Remove the files this deploy created. */
  async rollback(): Promise<void> {
    for (const f of this.created.splice(0).reverse())
      await removeFileIfExists(f).catch(() => undefined);
  }
}

/** One deploy call: its input, paths and layout, the plan being built and its writer. */
interface Job {
  input: DeployInput;
  paths: ScopePaths;
  layout: TargetLayout;
  plan: DeployPlan;
  writer: Writer;
}

/** Flush the planned writes and return the plan's result. */
async function commit(job: Job): Promise<DeployResult> {
  await job.writer.flush();
  return job.plan.result();
}

function defOf<K extends Entity['def']['kind']>(
  entity: Entity,
  kind: K,
): Extract<Entity['def'], { kind: K }> {
  if (entity.def.kind !== kind)
    throw new PalmError(
      'E_INTERNAL',
      `entity ${entity.name}: expected a ${kind} definition, got ${entity.def.kind}`,
    );
  return entity.def as Extract<Entity['def'], { kind: K }>;
}

/**
 * Copy the plugin root a hook's commands reference into `assetDir` (the whole root: scripts
 * may read sibling files such as skills/<name>/SKILL.md), minus documentation, tests and CI
 * material that no hook runs.
 */
async function planHookAssets(job: Job, hooks: HookSet, assetDir: string): Promise<void> {
  const { entity, originRoot, absPath } = job.input;
  const src =
    hooks.pluginRootRel !== undefined
      ? path.resolve(originRoot, hooks.pluginRootRel)
      : path.dirname(absPath);
  const boundary = isWithin(absPath, originRoot) ? originRoot : path.dirname(absPath);
  if (!isWithin(src, boundary)) {
    throw new PalmError(
      'E_PARSE',
      `hooks ${entity.name}: plugin root ${src} lies outside the origin ${boundary}`,
    );
  }
  if (!(await pathExists(src))) {
    job.plan.note(`hooks ${entity.name}: plugin root ${src} not found; commands may fail`);
    return;
  }
  const { files, skipped } = await listCopyFiles(src, { skipTop: HOOK_ASSET_SKIP_TOP, boundary });
  for (const f of files) {
    if (!f.rel.includes('/') && HOOK_ASSET_SKIP_FILE.test(f.rel)) continue;
    job.plan.write(path.join(assetDir, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
  }
  if (skipped.length)
    job.plan.note(
      `hooks ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
    );
  job.plan.note(`hook scripts copied to ${job.paths.lockForm(assetDir)}`);
}

/** Append every converted hook entry to the shared hooks file, one record per entry. */
async function mergeHookEvents(
  job: Job,
  hooks: { mergeFile: string; versioned?: boolean },
  events: Record<string, unknown[]>,
): Promise<void> {
  const { dryRun } = job.input;
  const file = hooks.mergeFile;
  if (hooks.versioned) await ensureJsonKey(file, ['version'], 1, { dryRun });
  for (const [event, items] of Object.entries(events)) {
    for (const item of items)
      job.plan.addMerged(await appendJsonItem(file, ['hooks', event], item, { dryRun }));
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
    const plan = new DeployPlan(paths);
    const job: Job = {
      input,
      paths,
      layout: this.spec.layout(paths),
      plan,
      writer: new Writer(input, plan),
    };
    try {
      return await this.deployKind(job);
    } catch (e) {
      await job.writer.rollback();
      throw e;
    }
  }

  private async deployKind(job: Job): Promise<DeployResult> {
    switch (job.input.entity.def.kind) {
      case 'skill':
        return this.deploySkill(job);
      case 'agent':
        return this.deployAgent(job);
      case 'instruction':
        return this.deployInstruction(job);
      case 'command':
        return this.deployCommand(job);
      case 'hook':
        return this.deployHook(job);
      case 'mcp':
        return this.deployMcp(job);
      case 'plugin':
        job.plan.note(`plugin ${job.input.entity.name}: members are installed individually`);
        return job.plan.result(true);
    }
  }

  private async deploySkill(job: Job): Promise<DeployResult> {
    const { entity, absPath, originRoot } = job.input;
    const dest = path.join(job.layout.skillsDir, entity.name);
    // Links may point anywhere inside the origin (shared references), never outside it.
    const boundary = isWithin(absPath, originRoot) ? originRoot : absPath;
    const { files, skipped } = await listCopyFiles(absPath, { boundary }).catch((e: unknown) => {
      throw new PalmError('E_IO', `skill ${entity.name}: cannot read ${absPath}: ${messageOf(e)}`);
    });
    if (skipped.length)
      job.plan.note(
        `skill ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
      );
    if (files.length === 0)
      throw new PalmError('E_NOT_FOUND', `skill ${entity.name}: no files in ${absPath}`);
    for (const f of files)
      job.plan.write(path.join(dest, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
    return commit(job);
  }

  private async deployAgent(job: Job): Promise<DeployResult> {
    const { agent } = defOf(job.input.entity, 'agent');
    const r = renderAgent({ ...agent, name: job.input.entity.name }, this.id);
    const dest = path.join(job.layout.agentsDir, r.fileName);
    job.plan.write(dest, r.content);
    await job.writer.flush();
    if (r.dropped.length)
      job.plan.note(
        `${job.paths.lockForm(dest)}: dropped ${r.dropped.join(', ')} (not supported by ${this.displayName})`,
      );
    return job.plan.result();
  }

  private async deployInstruction(job: Job): Promise<DeployResult> {
    const { instruction } = defOf(job.input.entity, 'instruction');
    const { layout, plan } = job;
    const name = job.input.entity.name;
    if ('skip' in layout.instructions) {
      plan.note(layout.instructions.skip);
      return plan.result(true);
    }
    const r = renderInstruction({ ...instruction, name }, this.id);
    if ('managedBlock' in r) {
      const file =
        'agentsMd' in layout.instructions
          ? layout.instructions.agentsMd
          : path.join(layout.instructions.dir, 'AGENTS.md');
      const id = `instruction:${name}`;
      const rec = await upsertManagedBlock(file, id, r.managedBlock, {
        dryRun: job.input.dryRun,
        onConflict: job.writer.onConflict(file, blockPointer(id)),
        displayFile: job.paths.lockForm(file),
      });
      plan.addMerged(rec);
      return plan.result();
    }
    if (!('dir' in layout.instructions))
      throw new PalmError('E_INTERNAL', `${this.id}: no instruction directory`);
    plan.write(path.join(layout.instructions.dir, r.fileName), r.content);
    return commit(job);
  }

  private async deployCommand(job: Job): Promise<DeployResult> {
    const { command } = defOf(job.input.entity, 'command');
    const { commands } = job.layout;
    if ('skip' in commands) {
      job.plan.note(commands.skip);
      return job.plan.result(true);
    }
    const r = renderCommand({ ...command, name: job.input.entity.name }, this.id);
    job.plan.write(path.join(commands.dir, r.fileName), r.content);
    return commit(job);
  }

  private async deployHook(job: Job): Promise<DeployResult> {
    const { hooks } = defOf(job.input.entity, 'hook');
    const { entity } = job.input;
    const { layout, plan } = job;
    const assetDir = job.paths.hooksAssetDir(entity.name);
    const converted = convertHooks(hooks, this.id, assetDir, job.paths);
    if (converted.dropped.length)
      plan.note(
        `hooks ${entity.name}: dropped for ${this.displayName}: ${converted.dropped.join('; ')}`,
      );
    const events = (converted.hooks as { hooks: Record<string, unknown[]> }).hooks;
    if (Object.values(events).every((items) => items.length === 0)) {
      plan.note(`hooks ${entity.name}: nothing ${this.displayName} can run`);
      return plan.result(true);
    }
    if (referencesPluginRoot(hooks.raw)) await planHookAssets(job, hooks, assetDir);
    if ('dir' in layout.hooks) {
      plan.write(
        path.join(layout.hooks.dir, `${entity.name}.json`),
        stringifyJson(converted.hooks),
      );
      return commit(job);
    }
    await job.writer.check();
    await mergeHookEvents(job, layout.hooks, events);
    return commit(job);
  }

  private async deployMcp(job: Job): Promise<DeployResult> {
    const { mcp } = defOf(job.input.entity, 'mcp');
    const { secretPolicy, secretValues, scope, dryRun } = job.input;
    const { layout, plan } = job;
    const key = mcp.name || job.input.entity.name;
    const r = renderMcp({ ...mcp, name: key }, this.id, secretPolicy, secretValues ?? {}, scope);
    for (const n of r.notes) plan.note(n);
    if (!r.entry) return plan.result(true);
    const file = 'toml' in layout.mcp ? layout.mcp.toml : layout.mcp.json;
    const created = !(await pathExists(file));
    const keyPath = 'toml' in layout.mcp ? ['mcp_servers', key] : [...layout.mcp.path, key];
    const opts = {
      dryRun,
      onConflict: job.writer.onConflict(file, formatPointer(keyPath)),
      displayFile: job.paths.lockForm(file),
    };
    const rec =
      'toml' in layout.mcp
        ? await mergeTomlTable(file, keyPath, r.entry, opts)
        : await setJsonKey(file, keyPath, r.entry, opts);
    // The lockfile (and --json output) records placeholders, never literal secret values.
    plan.addMerged({ ...rec, value: redactSecrets(rec.value, secretValues) });
    // User-level MCP configs and anything holding literal secrets: private to the user when palm creates them.
    const literal = secretPolicy === 'literal' && Object.keys(secretValues ?? {}).length > 0;
    if (created && !dryRun && (scope === 'global' || literal)) await ensureMode(file, 0o600);
    if (r.envRefs.length)
      plan.note(
        `MCP ${key}: export ${r.envRefs.join(', ')} in the environment ${this.displayName} runs in`,
      );
    return plan.result();
  }

  /**
   * Remove this target's share of a lock entry. Files outside this target's roots
   * (another target's files) are ignored; missing files are fine. Shared
   * `.agents/skills` and `.palm/hooks` paths are claimed by several targets and
   * removed by whichever runs first.
   */
  async undeploy(
    entry: LockEntry,
    scope: Scope,
    scopeRoot: string,
    dryRun: boolean,
    env?: NodeJS.ProcessEnv,
  ): Promise<void> {
    if (dryRun) return;
    const paths = this.paths(scope, scopeRoot, env);
    const layout = this.spec.layout(paths);
    const roots = [...layout.roots, { dir: paths.hooksDir, stop: paths.palmDir }];
    for (const f of entry.files) {
      const abs = paths.abs(f);
      const root = rootOf(roots, abs);
      if (!root) continue;
      await removeFileIfExists(abs);
      await removeEmptyParents(abs, root.stop);
    }
    for (const stored of entry.merged ?? []) {
      const abs = paths.abs(stored.file);
      const claimed =
        layout.mergedFiles.includes(abs) || layout.roots.some((r) => isWithin(abs, r.dir));
      if (claimed) await unmerge(parseMergedRecord({ ...stored, file: abs }));
    }
    if (entry.kind === 'hook' && isSafeName(entry.name)) {
      const dir = paths.hooksAssetDir(entry.name);
      await removeDirIfExists(dir);
      await removeEmptyParents(dir, paths.palmDir);
    }
  }
}
