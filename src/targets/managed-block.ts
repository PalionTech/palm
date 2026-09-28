/**
 * Palm-owned sections inside shared markdown files (Codex `AGENTS.md`):
 *
 *   <!-- palm:begin instruction:<name> -->
 *   ...content...
 *   <!-- palm:end instruction:<name> -->
 *
 * Upsert replaces an existing block in place (everything outside it stays
 * byte-identical) or appends one after a blank line. The file always ends with a
 * newline after an upsert. Record: `{ file, pointer: "block:<id>", value: content }`.
 */
import { promises as fs } from 'node:fs';
import { PalmError } from '../core/errors.js';
import type { MergedRecord } from '../core/types.js';
import { atomicWrite, readTextOrUndefined } from './fs-utils.js';

export const BLOCK_POINTER_PREFIX = 'block:';

export function beginMarker(id: string): string {
  return `<!-- palm:begin ${id} -->`;
}

export function endMarker(id: string): string {
  return `<!-- palm:end ${id} -->`;
}

export function renderBlock(id: string, content: string): string {
  return `${beginMarker(id)}\n${content.replace(/\n+$/, '')}\n${endMarker(id)}`;
}

/** Locate a block: `start` = index of the begin marker, `end` = index just past the end marker. */
export function findManagedBlock(
  text: string,
  id: string,
): { start: number; end: number; content: string } | undefined {
  const begin = beginMarker(id);
  const end = endMarker(id);
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const endIdx = text.indexOf(end, start + begin.length);
  if (endIdx < 0) return undefined;
  const inner = text
    .slice(start + begin.length, endIdx)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
  return { start, end: endIdx + end.length, content: inner };
}

export interface ManagedBlockOptions {
  dryRun: boolean;
  /** Existing block with different content: overwrite (default) or throw E_CONFLICT. */
  onConflict?: 'overwrite' | 'error';
  displayFile?: string;
}

export async function upsertManagedBlock(
  file: string,
  id: string,
  content: string,
  opts: ManagedBlockOptions,
): Promise<MergedRecord> {
  const record: MergedRecord = { file, pointer: `${BLOCK_POINTER_PREFIX}${id}`, value: content };
  const text = (await readTextOrUndefined(file)) ?? '';
  const block = renderBlock(id, content);
  const found = findManagedBlock(text, id);
  let next: string;
  if (found) {
    if (found.content === content.replace(/\n+$/, '')) {
      if (text.endsWith('\n')) return record;
      next = text + '\n';
    } else {
      if (opts.onConflict === 'error') {
        throw new PalmError(
          'E_CONFLICT',
          `refusing to overwrite ${opts.displayFile ?? file} (palm block "${id}" exists with different content)`,
          'rerun with --force',
        );
      }
      next = text.slice(0, found.start) + block + text.slice(found.end);
      if (!next.endsWith('\n')) next += '\n';
    }
  } else if (text === '') {
    next = block + '\n';
  } else {
    const base = text.endsWith('\n') ? text : text + '\n';
    next = base + (base.endsWith('\n\n') ? '' : '\n') + block + '\n';
  }
  if (!opts.dryRun) await atomicWrite(file, next);
  return record;
}

/**
 * Remove the block (and the blank line that separated it from preceding text).
 * A file left empty is deleted. Missing file/block is a no-op.
 */
export async function removeManagedBlock(file: string, id: string): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined) return;
  const found = findManagedBlock(text, id);
  if (!found) return;
  let before = text.slice(0, found.start);
  let after = text.slice(found.end);
  if (after.startsWith('\r\n')) after = after.slice(2);
  else if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  const next = before + after;
  if (next.trim() === '') {
    await fs.rm(file, { force: true });
    return;
  }
  await atomicWrite(file, next);
}
