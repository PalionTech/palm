/**
 * The files the post-scan passes (hidden Unicode, secrets) read: a skill's directory walked like
 * the deploy copy walks it (`SKILL_COPY_SKIP` left out), an entity's own files, and the files of a
 * hook's or server's closure. Binary files (a NUL byte in the first 8 KB) and files over 1 MB are
 * not read.
 */

import { type FileHandle, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Closure, Entity } from '../core/types.js';
import { isClosureExcluded, shouldSkipFile } from '../domain/ignore.js';
import { isSkillCopySkipped } from '../domain/skill-copy.js';
import { walkFiles } from '../lib/fs.js';
import { isCommandSkill } from './entity-registry.js';
import type { ScanContext } from './scan-context.js';
import { joinRel } from './util.js';

const MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
/** Most files fit in the first read, so they cost open + read + close (no stat). */
const FIRST_READ_BYTES = 16 * 1024;

export interface SourceFile {
  /** Source-relative path (shown in messages). */
  rel: string;
  abs: string;
}

/** Text of a file worth checking; undefined for binary, oversized and unreadable files. */
export async function readScannable(abs: string): Promise<string | undefined> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(abs, 'r');
    const head = Buffer.allocUnsafe(FIRST_READ_BYTES);
    const { bytesRead } = await fh.read(head, 0, FIRST_READ_BYTES, 0);
    if (head.subarray(0, Math.min(bytesRead, BINARY_PROBE_BYTES)).includes(0)) return undefined;
    if (bytesRead < FIRST_READ_BYTES) return head.toString('utf8', 0, bytesRead);
    if ((await fh.stat()).size > MAX_BYTES) return undefined;
    return (await readFile(abs)).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Files below the source-relative directory `rel` (`.` = the root) the walk does not `skip`. */
async function walkedFiles(
  ctx: ScanContext,
  rel: string,
  skip: (name: string) => boolean,
): Promise<SourceFile[]> {
  const dirRel = rel === '.' ? '' : rel;
  const walked = await walkFiles(join(ctx.rootAbs, dirRel), {
    boundary: ctx.rootAbs,
    skip: (name: string) => skip(name),
  }).catch(() => ({ files: [] }));
  return walked.files.map((f) => ({ rel: joinRel(dirRel, f.rel), abs: f.abs }));
}

const skipInClosure = (name: string): boolean => isClosureExcluded(name) || shouldSkipFile(name);

/** Every file a deploy copies for the closure (directories walked, `CLOSURE_NEVER` left out). */
export async function closureFiles(ctx: ScanContext, closure: Closure): Promise<SourceFile[]> {
  const lists = await Promise.all(
    closure.paths.map((p) =>
      ctx.files.locate(p) === 'file'
        ? [{ rel: p, abs: join(ctx.rootAbs, p) }]
        : walkedFiles(ctx, p, skipInClosure),
    ),
  );
  return lists.flat();
}

export function closureOfEntity(e: Entity): Closure | undefined {
  if (e.def.kind === 'hook') return e.def.hooks.closure;
  return e.def.kind === 'mcp' ? e.def.closure : undefined;
}

/**
 * The entity's own files: the files a skill copy takes from its directory (a command-skill's
 * file), else its definition files. Walked once per scan; both passes read the list.
 */
export function ownFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  let files = ctx.ownFiles.get(e);
  if (!files) {
    files = listOwnFiles(ctx, e);
    ctx.ownFiles.set(e, files);
  }
  return files;
}

async function listOwnFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  if (e.kind === 'skill' && !isCommandSkill(e))
    return walkedFiles(ctx, e.path, (name) => isSkillCopySkipped(name));
  const rels = [...new Set([e.path, ...(ctx.extraSources.get(e) ?? [])])];
  return rels.map((rel) => ({ rel, abs: join(ctx.rootAbs, rel) }));
}
