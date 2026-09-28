/**
 * A deploy in two halves.
 *
 * 1. Planning (planners.ts) fills a `DeployPlan`: whole files to write, and edits of shared
 *    files (hook JSON, MCP JSON/TOML, AGENTS.md blocks) computed as the file's next text by the
 *    pure transforms in json-merge.ts, toml-merge.ts and managed-block.ts. Planning reads the
 *    origin and the current shared files but writes nothing; merge conflicts surface here.
 * 2. The `Writer` checks every planned file against the collision policy, then applies the
 *    edits and the files in one pass. Before touching a path it journals what the path held
 *    (bytes and mode, or "absent" plus the nearest directory that existed); on any failure it
 *    restores the journal newest first, so a failed deploy leaves the scope byte-identical.
 */
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import type {
  DeployInput,
  DeployResult,
  MergedRecord as StoredMergedRecord,
} from '../core/types.js';
import { type MergedRecord, toStored } from '../domain/merged-record.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isSameFile, pathExists, removeEmptyParents } from '../lib/fs.js';
import {
  atomicWrite,
  ensureMode,
  readFileOrUndefined,
  readTextOrUndefined,
  removeFileIfExists,
  statMode,
  writeTargetPath,
} from './fs-utils.js';

type OnConflict = 'overwrite' | 'error';

/** A whole file to write. */
interface PlannedWrite {
  abs: string;
  data: Buffer;
  mode?: number;
}

/** A shared file palm merges into: its text after every merge planned so far. */
export interface PlannedEdit {
  abs: string;
  /** True when the file existed when planning started. */
  existed: boolean;
  /** Planned text; undefined while the file is absent and no merge created it. */
  text: string | undefined;
  /** True once a merge changed the text (an untouched file is never rewritten). */
  changed: boolean;
  /** Permission bits when palm creates the file (user-level MCP and settings files: 0600). */
  createMode?: number;
  /** Permission bits set even on an existing file (one that now holds a literal secret: 0600). */
  mode?: number;
}

/** What one deploy produces: writes, edits, the result's files, records and notes. No IO. */
export class DeployPlan {
  readonly writes: PlannedWrite[] = [];
  readonly edits = new Map<string, PlannedEdit>();
  /** Deployed files, lock form. */
  private readonly files: string[] = [];
  /** Merged records, lock form. */
  private readonly merged: StoredMergedRecord[] = [];
  private readonly notes: string[] = [];

  constructor(readonly paths: ScopePaths) {}

  note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  /** Plan writing `data` to `abs`; the file is reported in the result. */
  write(abs: string, data: string | Buffer, mode?: number): void {
    this.writes.push({
      abs,
      data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mode,
    });
    const f = this.paths.lockForm(abs);
    if (!this.files.includes(f)) this.files.push(f);
  }

  /** Start tracking the shared file `abs` with the text it has now. */
  track(abs: string, text: string | undefined): PlannedEdit {
    const edit = { abs, existed: text !== undefined, text, changed: false };
    this.edits.set(abs, edit);
    return edit;
  }

  /** Record what a merge put into a shared file (lock form, as the result reports it). */
  addMerged(rec: MergedRecord): void {
    this.merged.push(toStored({ ...rec, file: this.paths.lockForm(rec.file) }));
  }

  result(skipped?: boolean, createdDirs: string[] = []): DeployResult {
    return {
      files: this.files,
      merged: this.merged,
      notes: this.notes,
      ...(skipped ? { skipped: true } : {}),
      ...(createdDirs.length
        ? { createdDirs: createdDirs.map((d) => this.paths.lockForm(d)) }
        : {}),
    };
  }
}

/**
 * Plan one merge into the shared file `abs`: `transform` maps its planned text (read from
 * disk the first time) to the next, or returns undefined when it has nothing to change.
 */
export async function planMerge(
  plan: DeployPlan,
  abs: string,
  transform: (text: string | undefined) => string | undefined,
): Promise<PlannedEdit> {
  const edit = plan.edits.get(abs) ?? plan.track(abs, await readTextOrUndefined(abs));
  const next = transform(edit.text);
  if (next !== undefined) {
    edit.text = next;
    edit.changed = true;
  }
  return edit;
}

/** Which existing content a deploy may replace: its own (per the lock) or anything with --force. */
export class Ownership {
  private readonly owned: Set<string>;

  constructor(
    private readonly input: DeployInput,
    private readonly paths: ScopePaths,
  ) {
    this.owned = new Set(input.ownedFiles.map((f) => this.ownedKey(f)));
  }

  /** ownedFiles entries may be `file` or `file#pointer` (merged entries). */
  private ownedKey(f: string): string {
    const hash = f.indexOf('#');
    if (hash < 0) return this.paths.abs(f);
    return `${this.paths.abs(f.slice(0, hash))}#${f.slice(hash + 1)}`;
  }

  private isOwned(abs: string, pointer?: string): boolean {
    return this.owned.has(abs) || (pointer !== undefined && this.owned.has(`${abs}#${pointer}`));
  }

  /**
   * True when a different existing file at `abs` may be overwritten: forced, owned, or the
   * same file as an owned path (a case variant of it on a case-insensitive filesystem).
   */
  async mayReplace(abs: string): Promise<boolean> {
    if (this.input.force || this.isOwned(abs)) return true;
    const lower = abs.toLowerCase();
    for (const owned of this.owned)
      if (owned.toLowerCase() === lower && (await isSameFile(owned, abs))) return true;
    return false;
  }

  /** Conflict mode for a merged entry: overwrite when forced or owned (file or file#pointer). */
  onConflict(abs: string, pointer: string): OnConflict {
    return this.input.force || this.isOwned(abs, pointer) ? 'overwrite' : 'error';
  }
}

/** A planned write after the collision check: `same` when the file already holds its bytes. */
type CheckedWrite = PlannedWrite & { same: boolean };

/** What a path held before the Writer touched it. */
interface JournalEntry {
  abs: string;
  /** Previous bytes; undefined when the path was absent. */
  before?: Buffer;
  mode?: number;
  /** Absent paths: the nearest directory that existed (created directories below it are pruned). */
  keepDir?: string;
}

async function nearestExistingDir(dir: string): Promise<string> {
  let cur = dir;
  while (!(await pathExists(cur)) && path.dirname(cur) !== cur) cur = path.dirname(cur);
  return cur;
}

async function journalOf(abs: string): Promise<JournalEntry> {
  const before = await readFileOrUndefined(abs);
  if (before !== undefined) return { abs, before, mode: await statMode(abs) };
  return { abs, keepDir: await nearestExistingDir(path.dirname(abs)) };
}

/** Put a journaled path back: previous bytes and mode, or remove what was created. */
async function restore(j: JournalEntry): Promise<void> {
  if (j.before !== undefined) {
    await atomicWrite(j.abs, j.before, j.mode);
    return;
  }
  // A dangling symlink palm wrote through keeps its link; the target it created goes.
  await removeFileIfExists(await writeTargetPath(j.abs));
  if (j.keepDir) await removeEmptyParents(j.abs, j.keepDir);
}

/**
 * Applies a plan: the collision check for every whole file first (identical content is a
 * no-op, a foreign different file is E_CONFLICT unless forced or owned), then the changed
 * shared files, then the whole files. `rollback()` restores everything it touched.
 */
export class Writer {
  private readonly journal: JournalEntry[] = [];

  constructor(
    private readonly plan: DeployPlan,
    private readonly owner: Ownership,
    private readonly dryRun: boolean,
  ) {}

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
    if (existing?.equals(w.data)) return { ...w, same: true };
    if (existing && !(await this.owner.mayReplace(w.abs)))
      throw new PalmError('E_CONFLICT', `refusing to overwrite ${shown}`, 'to overwrite it, run', {
        retryWith: '--force',
      });
    return { ...w, same: false };
  }

  /** Journal `abs`, then change it. */
  private async touch(abs: string, change: () => Promise<void>): Promise<void> {
    this.journal.push(await journalOf(abs));
    await change();
  }

  private async applyWrite(w: CheckedWrite): Promise<void> {
    const { mode } = w;
    if (!w.same) await this.touch(w.abs, () => atomicWrite(w.abs, w.data, mode));
    else if (mode !== undefined && (await statMode(w.abs)) !== mode)
      await this.touch(w.abs, () => ensureMode(w.abs, mode));
  }

  private async applyEdit(e: PlannedEdit): Promise<void> {
    const { text, mode: forced } = e;
    if (text === undefined) return;
    const mode = forced ?? (e.existed ? undefined : e.createMode);
    if (e.changed) await this.touch(e.abs, () => atomicWrite(e.abs, text, mode));
    else if (forced !== undefined && (await statMode(e.abs)) !== forced)
      await this.touch(e.abs, () => ensureMode(e.abs, forced));
  }

  /** Check, then write the shared files and the whole files (nothing at all on a dry run). */
  async apply(): Promise<void> {
    const checked: CheckedWrite[] = [];
    for (const w of this.plan.writes) checked.push(await this.checkOne(w));
    if (this.dryRun) return;
    for (const e of this.plan.edits.values()) await this.applyEdit(e);
    for (const w of checked) await this.applyWrite(w);
  }

  /** Restore every path this writer touched, newest first; best effort. */
  async rollback(): Promise<void> {
    for (const j of this.journal.splice(0).reverse()) await restore(j).catch(() => undefined);
  }
}
