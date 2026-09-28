/**
 * Generic Target implementation. Each harness supplies a `TargetLayout` (where each
 * kind goes at a scope) and a detect function; deploy/undeploy logic is shared.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import type {
  DeployInput,
  DeployResult,
  Entity,
  LockEntry,
  MergedRecord,
  Scope,
  Target,
  TargetId,
} from '../core/types.js';
import { renderAgent } from './convert-agent.js';
import { renderCommand } from './convert-command.js';
import { convertHooks, referencesPluginRoot } from './convert-hooks.js';
import { renderInstruction } from './convert-instruction.js';
import { redactSecrets } from './deep-equal.js';
import { type Env, effectiveEnv, hooksAssetDir, palmHooksRoot } from './env.js';
import {
  atomicWrite,
  ensureMode,
  isWithin,
  listCopyFiles,
  pathExists,
  readFileOrUndefined,
  removeDirIfExists,
  removeEmptyParents,
  removeFileIfExists,
  toPosix,
} from './fs-utils.js';
import { ensureJsonKey, mergeJsonFile, unmergeJsonFile } from './json-merge.js';
import { escapeSegment, joinPointer } from './json-pointer.js';
import { BLOCK_POINTER_PREFIX, removeManagedBlock, upsertManagedBlock } from './managed-block.js';
import { renderMcp } from './mcp-config.js';
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
  mcp: { json: string; pointer: string } | { toml: string };
  /** Directories this target writes files into (claims them at undeploy). */
  roots: CleanupRoot[];
  /** Shared files outside `roots` this target merges into. */
  mergedFiles: string[];
}

export interface TargetSpec {
  id: TargetId;
  displayName: string;
  layout(scope: Scope, scopeRoot: string, env: Env): TargetLayout;
  detect(scope: Scope, scopeRoot: string, env: Env): Promise<boolean>;
}

type OnConflict = 'overwrite' | 'error';

/** Plugin-root entries never copied with hook scripts: docs, tests, CI and repository furniture. */
const HOOK_ASSET_SKIP_TOP = [
  '.github',
  '.gitlab',
  '.vscode',
  '.idea',
  'docs',
  'doc',
  'website',
  'site',
  'test',
  'tests',
  '__tests__',
  'spec',
  'fixtures',
  'examples',
  'example',
  'evals',
  'assets',
  'media',
  'images',
  'screenshots',
];
const HOOK_ASSET_SKIP_FILE =
  /^(README|CHANGELOG|CHANGES|HISTORY|RELEASE[-_]NOTES|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i;

/** Entity names become file and directory names: refuse anything that could leave its directory. */
export function isSafeEntityName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function assertSafeEntityName(entity: Entity): void {
  if (!isSafeEntityName(entity.name)) {
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

/** Per-deploy bookkeeping: collision policy, lock-form paths, notes. */
class DeployCtx {
  readonly files: string[] = [];
  readonly merged: MergedRecord[] = [];
  readonly notes: string[] = [];
  private readonly owned: Set<string>;
  private readonly planned: PlannedWrite[] = [];
  /** Files this deploy created (did not exist before), for rollback when a later write fails. */
  private readonly created: string[] = [];

  constructor(
    readonly input: DeployInput,
    readonly env: Env,
  ) {
    this.owned = new Set(input.ownedFiles.map((f) => this.ownedKey(f)));
  }

  get scope(): Scope {
    return this.input.scope;
  }

  abs(f: string): string {
    return path.isAbsolute(f) ? f : path.join(this.input.scopeRoot, f);
  }

  /** Lock form: scope-relative (posix) for project scope, absolute for global. */
  display(abs: string): string {
    return this.input.scope === 'project' ? toPosix(path.relative(this.input.scopeRoot, abs)) : abs;
  }

  /** ownedFiles entries may be `file` or `file#pointer` (merged entries). */
  private ownedKey(f: string): string {
    const hash = f.indexOf('#');
    return hash < 0 ? this.abs(f) : `${this.abs(f.slice(0, hash))}#${f.slice(hash + 1)}`;
  }

  isOwned(abs: string, pointer?: string): boolean {
    return this.owned.has(abs) || (pointer !== undefined && this.owned.has(`${abs}#${pointer}`));
  }

  /** Conflict mode for a merged entry: overwrite when forced or owned (file or file#pointer). */
  onConflict(abs: string, pointer: string): OnConflict {
    return this.input.force || this.isOwned(abs, pointer) ? 'overwrite' : 'error';
  }

  note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  addFile(abs: string): void {
    const d = this.display(abs);
    if (!this.files.includes(d)) this.files.push(d);
  }

  addMerged(rec: MergedRecord): void {
    this.merged.push({ ...rec, file: this.display(rec.file) });
  }

  plan(abs: string, data: string | Buffer, mode?: number): void {
    this.planned.push({
      abs,
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mode,
    });
  }

  /**
   * Check every planned write against the collision policy before anything is
   * written: identical content → no-op; foreign different file → E_CONFLICT unless
   * forced or owned. Returns the writes that are actually needed.
   */
  private async checkPlanned(): Promise<Array<PlannedWrite & { exists: boolean }>> {
    const needed: Array<PlannedWrite & { exists: boolean }> = [];
    for (const w of this.planned) {
      let existing: Buffer | undefined;
      try {
        existing = await readFileOrUndefined(w.abs);
      } catch {
        throw new PalmError(
          'E_CONFLICT',
          `refusing to overwrite ${this.display(w.abs)} (not a regular file)`,
          'move it aside and retry',
        );
      }
      if (existing?.equals(w.data)) {
        needed.push({ ...w, exists: true });
        continue;
      }
      if (existing && !this.input.force && !this.isOwned(w.abs)) {
        throw new PalmError(
          'E_CONFLICT',
          `refusing to overwrite ${this.display(w.abs)}`,
          'rerun with --force',
        );
      }
      needed.push({ ...w, exists: false });
    }
    return needed;
  }

  private checked?: Array<PlannedWrite & { exists: boolean }>;

  async check(): Promise<void> {
    this.checked = await this.checkPlanned();
  }

  /** Perform planned writes (after check()); identical files only get their mode fixed. */
  async flush(): Promise<void> {
    const writes = this.checked ?? (await this.checkPlanned());
    for (const w of writes) {
      if (!this.input.dryRun) {
        if (w.exists) {
          if (w.mode !== undefined) await ensureMode(w.abs, w.mode);
        } else {
          const existed = await pathExists(w.abs);
          await atomicWrite(w.abs, w.data, w.mode);
          if (!existed) this.created.push(w.abs);
        }
      }
      this.addFile(w.abs);
    }
    this.planned.length = 0;
    this.checked = undefined;
  }

  /** Remove the files this deploy created, so a failed deploy leaves nothing untracked behind. */
  async rollback(): Promise<void> {
    for (const f of this.created.splice(0).reverse())
      await removeFileIfExists(f).catch(() => undefined);
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

export class GenericTarget implements Target {
  readonly id: TargetId;
  readonly displayName: string;

  constructor(
    private readonly spec: TargetSpec,
    private readonly boundEnv?: Env,
  ) {
    this.id = spec.id;
    this.displayName = spec.displayName;
  }

  detect(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    return this.spec.detect(scope, scopeRoot, env);
  }

  configDir(scope: Scope, scopeRoot: string, env: NodeJS.ProcessEnv): string {
    return this.spec.layout(scope, scopeRoot, env).configDir;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    assertSafeEntityName(input.entity);
    const env = effectiveEnv(input.scope, input.scopeRoot, input.env, this.boundEnv);
    const layout = this.spec.layout(input.scope, input.scopeRoot, env);
    const ctx = new DeployCtx(input, env);
    try {
      return await this.deployKind(ctx, layout);
    } catch (e) {
      await ctx.rollback();
      throw e;
    }
  }

  private async deployKind(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const input = ctx.input;
    switch (input.entity.def.kind) {
      case 'skill':
        return this.deploySkill(ctx, layout);
      case 'agent':
        return this.deployAgent(ctx, layout);
      case 'instruction':
        return this.deployInstruction(ctx, layout);
      case 'command':
        return this.deployCommand(ctx, layout);
      case 'hook':
        return this.deployHook(ctx, layout);
      case 'mcp':
        return this.deployMcp(ctx, layout);
      case 'plugin':
        ctx.note(`plugin ${input.entity.name}: members are installed individually`);
        return ctx.result(true);
    }
  }

  private async deploySkill(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { entity, absPath, originRoot } = ctx.input;
    const dest = path.join(layout.skillsDir, entity.name);
    // Links may point anywhere inside the origin (shared references), never outside it.
    const boundary = isWithin(absPath, originRoot) ? originRoot : absPath;
    const { files, skipped } = await listCopyFiles(absPath, { boundary }).catch((e: unknown) => {
      throw new PalmError(
        'E_IO',
        `skill ${entity.name}: cannot read ${absPath}: ${(e as Error).message}`,
      );
    });
    if (skipped.length)
      ctx.note(
        `skill ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
      );
    if (files.length === 0)
      throw new PalmError('E_NOT_FOUND', `skill ${entity.name}: no files in ${absPath}`);
    for (const f of files)
      ctx.plan(path.join(dest, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
    await ctx.flush();
    return ctx.result();
  }

  private async deployAgent(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { agent } = defOf(ctx.input.entity, 'agent');
    const r = renderAgent({ ...agent, name: ctx.input.entity.name }, this.id);
    const dest = path.join(layout.agentsDir, r.fileName);
    ctx.plan(dest, r.content);
    await ctx.flush();
    if (r.dropped.length)
      ctx.note(
        `${ctx.display(dest)}: dropped ${r.dropped.join(', ')} (not supported by ${this.displayName})`,
      );
    return ctx.result();
  }

  private async deployInstruction(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { instruction } = defOf(ctx.input.entity, 'instruction');
    const name = ctx.input.entity.name;
    if ('skip' in layout.instructions) {
      ctx.note(layout.instructions.skip);
      return ctx.result(true);
    }
    const r = renderInstruction({ ...instruction, name }, this.id);
    if ('managedBlock' in r) {
      const file =
        'agentsMd' in layout.instructions
          ? layout.instructions.agentsMd
          : path.join(layout.instructions.dir, 'AGENTS.md');
      const id = `instruction:${name}`;
      const rec = await upsertManagedBlock(file, id, r.managedBlock, {
        dryRun: ctx.input.dryRun,
        onConflict: ctx.onConflict(file, `${BLOCK_POINTER_PREFIX}${id}`),
        displayFile: ctx.display(file),
      });
      ctx.addMerged(rec);
      return ctx.result();
    }
    if (!('dir' in layout.instructions))
      throw new PalmError('E_INTERNAL', `${this.id}: no instruction directory`);
    ctx.plan(path.join(layout.instructions.dir, r.fileName), r.content);
    await ctx.flush();
    return ctx.result();
  }

  private async deployCommand(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { command } = defOf(ctx.input.entity, 'command');
    if ('skip' in layout.commands) {
      ctx.note(layout.commands.skip);
      return ctx.result(true);
    }
    const r = renderCommand({ ...command, name: ctx.input.entity.name }, this.id);
    ctx.plan(path.join(layout.commands.dir, r.fileName), r.content);
    await ctx.flush();
    return ctx.result();
  }

  private async deployHook(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { hooks } = defOf(ctx.input.entity, 'hook');
    const { entity, scope, scopeRoot, originRoot, absPath, dryRun } = ctx.input;
    const assetDir = hooksAssetDir(scope, scopeRoot, ctx.env, entity.name);
    const converted = convertHooks(hooks, this.id, assetDir, scope);
    if (converted.dropped.length)
      ctx.note(
        `hooks ${entity.name}: dropped for ${this.displayName}: ${converted.dropped.join('; ')}`,
      );
    const events = (converted.hooks as { hooks: Record<string, unknown[]> }).hooks;
    if (Object.values(events).every((items) => items.length === 0)) {
      ctx.note(`hooks ${entity.name}: nothing ${this.displayName} can run`);
      return ctx.result(true);
    }

    if (referencesPluginRoot(hooks.raw)) {
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
      if (await pathExists(src)) {
        // The whole plugin root (scripts may read sibling files such as skills/*/SKILL.md),
        // minus documentation, tests and CI material that no hook runs.
        const { files, skipped } = await listCopyFiles(src, {
          skipTop: HOOK_ASSET_SKIP_TOP,
          boundary,
        });
        for (const f of files) {
          if (!f.rel.includes('/') && HOOK_ASSET_SKIP_FILE.test(f.rel)) continue;
          ctx.plan(path.join(assetDir, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
        }
        if (skipped.length)
          ctx.note(
            `hooks ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
          );
        ctx.note(`hook scripts copied to ${ctx.display(assetDir)}`);
      } else {
        ctx.note(`hooks ${entity.name}: plugin root ${src} not found; commands may fail`);
      }
    }

    if ('dir' in layout.hooks) {
      ctx.plan(
        path.join(layout.hooks.dir, `${entity.name}.json`),
        JSON.stringify(converted.hooks, null, 2) + '\n',
      );
      await ctx.flush();
      return ctx.result();
    }

    await ctx.check();
    const file = layout.hooks.mergeFile;
    if (layout.hooks.versioned) await ensureJsonKey(file, '', 'version', 1, { dryRun });
    for (const [event, items] of Object.entries(events)) {
      for (const item of items) {
        ctx.addMerged(
          await mergeJsonFile(file, `/hooks/${escapeSegment(event)}`, undefined, item, {
            dryRun,
            displayFile: ctx.display(file),
          }),
        );
      }
    }
    await ctx.flush();
    return ctx.result();
  }

  private async deployMcp(ctx: DeployCtx, layout: TargetLayout): Promise<DeployResult> {
    const { mcp } = defOf(ctx.input.entity, 'mcp');
    const { secretPolicy, secretValues, scope, dryRun } = ctx.input;
    const key = mcp.name || ctx.input.entity.name;
    const r = renderMcp({ ...mcp, name: key }, this.id, secretPolicy, secretValues ?? {}, scope);
    for (const n of r.notes) ctx.note(n);
    if (!r.entry) return ctx.result(true);
    const file = 'toml' in layout.mcp ? layout.mcp.toml : layout.mcp.json;
    const created = !(await pathExists(file));
    let rec: MergedRecord;
    if ('toml' in layout.mcp) {
      rec = await mergeTomlTable(file, ['mcp_servers', key], r.entry, {
        dryRun,
        onConflict: ctx.onConflict(file, `/mcp_servers/${escapeSegment(key)}`),
        displayFile: ctx.display(file),
      });
    } else {
      const { pointer } = layout.mcp;
      rec = await mergeJsonFile(file, pointer, key, r.entry, {
        dryRun,
        onConflict: ctx.onConflict(file, joinPointer(pointer, key)),
        displayFile: ctx.display(file),
      });
    }
    // The lockfile (and --json output) records placeholders, never literal secret values.
    ctx.addMerged({ ...rec, value: redactSecrets(rec.value, secretValues) });
    // User-level MCP configs and anything holding literal secrets: private to the user when palm creates them.
    if (
      created &&
      !dryRun &&
      (scope === 'global' ||
        (secretPolicy === 'literal' && Object.keys(secretValues ?? {}).length > 0))
    ) {
      await ensureMode(file, 0o600);
    }
    if (r.envRefs.length)
      ctx.note(
        `MCP ${key}: export ${r.envRefs.join(', ')} in the environment ${this.displayName} runs in`,
      );
    return ctx.result();
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
    const e = effectiveEnv(scope, scopeRoot, env, this.boundEnv);
    const layout = this.spec.layout(scope, scopeRoot, e);
    const palmRoot = palmHooksRoot(scope, scopeRoot, e);
    const roots = [...layout.roots, palmRoot];
    const toAbs = (f: string): string => (path.isAbsolute(f) ? f : path.join(scopeRoot, f));
    const rootOf = (abs: string): CleanupRoot | undefined =>
      roots
        .filter((r) => abs !== r.dir && isWithin(abs, r.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];

    for (const f of entry.files) {
      const abs = toAbs(f);
      const root = rootOf(abs);
      if (!root || dryRun) continue;
      await removeFileIfExists(abs);
      await removeEmptyParents(abs, root.stop);
    }

    for (const rec of entry.merged ?? []) {
      const abs = toAbs(rec.file);
      const claimed =
        layout.mergedFiles.includes(abs) || layout.roots.some((r) => isWithin(abs, r.dir));
      if (!claimed || dryRun) continue;
      if (rec.pointer.startsWith(BLOCK_POINTER_PREFIX))
        await removeManagedBlock(abs, rec.pointer.slice(BLOCK_POINTER_PREFIX.length));
      else if (abs.endsWith('.toml')) await unmergeTomlTable(abs, rec);
      else await unmergeJsonFile(abs, rec);
    }

    if (entry.kind === 'hook' && !dryRun && isSafeEntityName(entry.name)) {
      const dir = hooksAssetDir(scope, scopeRoot, e, entry.name);
      await removeDirIfExists(dir);
      await removeEmptyParents(dir, palmRoot.stop);
    }
  }
}
