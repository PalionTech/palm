/**
 * The Applier: writes one render as a transaction (DESIGN.md section 2, safety rules).
 *
 * 1. Check, before anything is written: every destination's real path lies inside the scope;
 *    a whole file that exists, is not owned by the entry and differs from the render is
 *    E_CONFLICT (an identical one is adopted and listed; one that says the same in other bytes,
 *    `sameContent`, is adopted and rewritten in palm's bytes); each shared file is read once and every
 *    fragment is inserted by (at, key) into its text: a held identical fragment is a no-op, a
 *    different one under the same key is E_CONFLICT unless the entry owns it or `force`.
 * 2. Write the shared files, then the whole files, journaling each path (bytes and mode, or
 *    absent plus the nearest existing directory) just before touching it. A failure restores the
 *    journal newest first, so the scope is byte-identical afterwards.
 *
 * A dry run performs step 1 only and returns the same result.
 */
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import { sameContent as sameText } from '../core/hash.js';
import type { ApplyInput, ApplyResult, LockMerged, RenderedFragment } from '../core/types.js';
import { parseMergedRecord } from '../domain/merged-record.js';
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
import { appendItemText, ensureKeyText, setKeyText } from './json-merge.js';
import { upsertBlockText } from './managed-block.js';

import { sameContent } from './same-content.js';
import { mergeTableText } from './toml-merge.js';

type OnConflict = 'overwrite' | 'error';

/** A whole file after the collision check. */
interface CheckedFile {
  lockPath: string;
  abs: string;
  data: Uint8Array;
  mode?: number;
  /** `same`: the disk holds these bytes already. */
  state: 'write' | 'same';
  /** Not owned, but the disk says the same in other bytes: adopted, palm's bytes written (Y13). */
  adopted?: boolean;
}

/** A shared file with every fragment merged into its text. */
interface PlannedEdit {
  abs: string;
  existed: boolean;
  text: string | undefined;
  changed: boolean;
  /** Mode when palm creates the file. */
  createMode?: number;
  /** Mode set even when the file exists. */
  mode?: number;
}

/** What a path held before the Applier touched it. */
interface JournalEntry {
  abs: string;
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

function notRegular(shown: string): PalmError {
  return new PalmError(
    'E_CONFLICT',
    `refusing to overwrite ${shown} (not a regular file)`,
    `mv ${shown} ${shown}.bak`,
  );
}

async function readOrRefuse<T>(read: () => Promise<T>, shown: string): Promise<T> {
  try {
    return await read();
  } catch {
    throw notRegular(shown);
  }
}

/** How one fragment merges: conflicts, ownership, and what to say when a hook is adopted (O11). */
interface MergeHow {
  onConflict: OnConflict;
  owned: boolean;
  onAdopt?: () => void;
}

/** Merge one fragment into a shared file's text; undefined when nothing changes. */
function mergeFragment(
  text: string | undefined,
  frag: RenderedFragment & { abs: string },
  how: MergeHow,
): string | undefined {
  const rec = parseMergedRecord({ ...frag, file: frag.abs });
  const { onConflict, owned, onAdopt } = how;
  const common = { file: frag.abs, onConflict, displayFile: frag.file };
  switch (rec.type) {
    case 'md-block':
      return upsertBlockText(text, { ...common, id: rec.key, content: rec.content });
    case 'toml-table':
      return mergeTableText(text, {
        ...common,
        path: rec.path,
        value: rec.value as Record<string, unknown>,
      });
    case 'json-item':
      return appendItemText(text, {
        ...common,
        path: rec.path,
        key: rec.key,
        value: rec.value,
        owned,
        ...(onAdopt ? { onAdopt } : {}),
      });
    case 'json-key':
      return setKeyText(text, { ...common, path: rec.path, value: rec.value });
  }
}

/** `.claude/settings.json: adopted the Stop hook already there (the same command); no second copy`. */
function adoptedHookNote(frag: RenderedFragment): string {
  const event = frag.at.split('/').at(-1) ?? frag.at;
  return `${frag.file}: adopted the ${event} hook already there (the same command); no second copy`;
}

export class Applier {
  private readonly owned: Set<string>;
  private readonly journal: JournalEntry[] = [];
  private readonly notes: string[];

  constructor(
    private readonly paths: ScopePaths,
    private readonly input: ApplyInput,
  ) {
    this.owned = new Set(input.owned);
    this.notes = [...input.rendered.notes];
  }

  private note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  /** The destination's real path must lie inside the scope (a symlink may not lead out). */
  private async assertInside(abs: string, shown: string): Promise<void> {
    const r = await this.paths.realInside(abs);
    if (r.inside) return;
    throw new PalmError(
      'E_IO',
      `refusing to write ${shown}: it resolves to ${r.real}, outside ${this.paths.root}`,
      `ls -l ${abs}`,
    );
  }

  /** True when the entry owns the file `lockPath` (or a case variant of it on disk). */
  private async ownsFile(lockPath: string, abs: string): Promise<boolean> {
    if (this.owned.has(lockPath)) return true;
    const lower = lockPath.toLowerCase();
    for (const o of this.owned)
      if (
        !o.includes('#') &&
        o.toLowerCase() === lower &&
        (await isSameFile(this.paths.abs(o), abs))
      )
        return true;
    return false;
  }

  private async checkFile(f: ApplyInput['rendered']['files'][number]): Promise<CheckedFile> {
    const abs = this.paths.abs(f.path);
    await this.assertInside(abs, f.path);
    const existing = await readOrRefuse(() => readFileOrUndefined(abs), f.path);
    const checked = { lockPath: f.path, abs, data: f.data, mode: f.mode };
    if (existing && sameText(existing, f.data)) return { ...checked, state: 'same' };
    if (!existing || this.input.force || (await this.ownsFile(f.path, abs)))
      return { ...checked, state: 'write' };
    if (sameContent(existing, f.data, f.path)) return { ...checked, state: 'write', adopted: true };
    throw new PalmError('E_CONFLICT', `refusing to overwrite ${f.path}`, 'to overwrite it, run', {
      retryWith: '--force',
    });
  }

  private ownsFragment(frag: RenderedFragment): boolean {
    return this.owned.has(`${frag.file}#${frag.at}#${frag.key}`);
  }

  private onConflict(frag: RenderedFragment): OnConflict {
    return this.input.force || this.ownsFragment(frag) ? 'overwrite' : 'error';
  }

  /** The shared file `file` with each of its fragments merged in (and the modes it gets). */
  private async planEdit(file: string, frags: readonly RenderedFragment[]): Promise<PlannedEdit> {
    const abs = this.paths.abs(file);
    await this.assertInside(abs, file);
    const before = await readOrRefuse(() => readTextOrUndefined(abs), file);
    let text = before;
    let changed = false;
    const apply = (next: string | undefined): void => {
      if (next === undefined) return;
      text = next;
      changed = true;
    };
    for (const frag of frags) {
      for (const [k, v] of Object.entries(frag.ensure ?? {}))
        apply(ensureKeyText(text, { file: abs, path: [k], value: v }));
      const how = {
        onConflict: this.onConflict(frag),
        owned: this.ownsFragment(frag),
        onAdopt: () => this.note(adoptedHookNote(frag)),
      };
      apply(mergeFragment(text, { ...frag, abs }, how));
    }
    const mode = frags.find((f) => f.mode !== undefined)?.mode;
    const createMode = frags.find((f) => f.createMode !== undefined)?.createMode;
    if (mode !== undefined && before !== undefined) await this.noteChmod(abs, file, mode);
    return { abs, existed: before !== undefined, text, changed, createMode, mode };
  }

  private async noteChmod(abs: string, file: string, mode: number): Promise<void> {
    const current = await statMode(abs);
    if (current !== undefined && current !== mode && (current & 0o077) !== 0)
      this.note(`${file}: permissions set to ${mode.toString(8)} (it now holds a literal secret)`);
  }

  private async planEdits(): Promise<PlannedEdit[]> {
    const byFile = new Map<string, RenderedFragment[]>();
    for (const frag of this.input.rendered.fragments as RenderedFragment[])
      byFile.set(frag.file, [...(byFile.get(frag.file) ?? []), frag]);
    const out: PlannedEdit[] = [];
    for (const [file, frags] of byFile) out.push(await this.planEdit(file, frags));
    return out;
  }

  /** Journal `abs`, then change it. */
  private async touch(abs: string, change: () => Promise<void>): Promise<void> {
    this.journal.push(await journalOf(abs));
    await change();
  }

  private async writeEdit(e: PlannedEdit): Promise<void> {
    const { text, mode: forced } = e;
    if (text === undefined) return;
    const mode = forced ?? (e.existed ? undefined : e.createMode);
    if (e.changed) await this.touch(e.abs, () => atomicWrite(e.abs, text, mode));
    else if (forced !== undefined && (await statMode(e.abs)) !== forced)
      await this.touch(e.abs, () => ensureMode(e.abs, forced));
  }

  private async writeFile(f: CheckedFile): Promise<void> {
    const { mode } = f;
    if (f.state === 'write')
      await this.touch(f.abs, () => atomicWrite(f.abs, Buffer.from(f.data), mode));
    else if (mode !== undefined && (await statMode(f.abs)) !== mode)
      await this.touch(f.abs, () => ensureMode(f.abs, mode));
  }

  /** Restore every path this Applier touched, newest first; best effort. */
  private async rollback(): Promise<void> {
    for (const j of this.journal.splice(0).reverse()) await restore(j).catch(() => undefined);
  }

  async run(): Promise<ApplyResult> {
    const files: CheckedFile[] = [];
    for (const f of this.input.rendered.files) files.push(await this.checkFile(f));
    const edits = await this.planEdits();
    if (!this.input.dryRun) {
      try {
        for (const e of edits) await this.writeEdit(e);
        for (const f of files) await this.writeFile(f);
      } catch (e) {
        await this.rollback();
        throw e;
      }
    }
    return this.result(files, edits);
  }

  private async result(
    files: readonly CheckedFile[],
    edits: readonly PlannedEdit[],
  ): Promise<ApplyResult> {
    const adopted: string[] = [];
    for (const f of files)
      if (f.adopted || (f.state === 'same' && !(await this.ownsFile(f.lockPath, f.abs))))
        adopted.push(f.lockPath);
    const created = new Set(edits.filter((e) => !e.existed && e.changed).map((e) => e.abs));
    const merged: LockMerged[] = this.input.rendered.fragments.map(({ file, at, id, key }) => ({
      file,
      at,
      id,
      key,
      ...(created.has(this.paths.abs(file)) ? { created: true } : {}),
    }));
    return {
      files: files.map((f) => f.lockPath).sort(),
      merged,
      adopted: adopted.sort(),
      notes: this.notes,
    };
  }
}
