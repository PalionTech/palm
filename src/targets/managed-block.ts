/**
 * Palm-owned sections inside shared markdown files (Codex `AGENTS.md`):
 *
 *   <!-- palm:begin instruction:<name> -->
 *   ...content...
 *   <!-- palm:end instruction:<name> -->
 *
 * Upsert replaces an existing block in place (everything outside it stays
 * byte-identical) or appends one after a blank line. The file always ends with a
 * newline after an upsert. Record: an `md-block` (stored as `{ file, pointer: "block:<id>",
 * value: content }`).
 */
import { promises as fs } from 'node:fs';
import { PalmError } from '../core/errors.js';
import type { MdBlockRecord } from '../domain/merged-record.js';
import { atomicWrite, readTextOrUndefined } from './fs-utils.js';

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

/** `text` ending with exactly the newline it had, or one added. */
function withFinalNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `text` with the block inserted or replaced; undefined when it is already there. */
function upsertedText(
  text: string,
  id: string,
  content: string,
  opts: ManagedBlockOptions & { file: string },
): string | undefined {
  const block = renderBlock(id, content);
  const found = findManagedBlock(text, id);
  if (!found) {
    if (text === '') return `${block}\n`;
    const base = withFinalNewline(text);
    return `${base}${base.endsWith('\n\n') ? '' : '\n'}${block}\n`;
  }
  if (found.content === content.replace(/\n+$/, ''))
    return text.endsWith('\n') ? undefined : `${text}\n`;
  if (opts.onConflict === 'error') {
    throw new PalmError(
      'E_CONFLICT',
      `refusing to overwrite ${opts.displayFile ?? opts.file} (palm block "${id}" exists with different content)`,
      'rerun with --force',
    );
  }
  return withFinalNewline(text.slice(0, found.start) + block + text.slice(found.end));
}

export async function upsertManagedBlock(
  file: string,
  id: string,
  content: string,
  opts: ManagedBlockOptions,
): Promise<MdBlockRecord> {
  const text = (await readTextOrUndefined(file)) ?? '';
  const next = upsertedText(text, id, content, { ...opts, file });
  if (next !== undefined && !opts.dryRun) await atomicWrite(file, next);
  return { type: 'md-block', file, id, content };
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
