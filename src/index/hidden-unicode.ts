/**
 * Hidden-Unicode pass (PLAN §2 item 11, DESIGN §5 "Scan issues"): every text file an entity
 * deploys is checked with `scanHiddenUnicode`. Findings become `Entity.issues` (one per file) and
 * one `hidden-unicode:` line per affected entity in the scan warnings.
 *
 * Files: a skill's whole directory, walked like the deploy copy walks it (COPY_SKIP, symlinks only
 * inside the origin); any other entity's source file(s); for a hook whose commands reference its
 * plugin root, also every file of that root the deploy copies next to it (the scripts it runs).
 * Binary files (a NUL byte in the first 8 KB) and files over 1 MB are skipped.
 */

import { type FileHandle, open, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Entity, EntityIssue } from '../core/types.js';
import { isSkippedHookAsset, referencesPluginRoot, shouldSkipFile } from '../domain/ignore.js';
import { walkFiles } from '../lib/fs.js';
import { plural } from '../lib/text.js';
import { describeCodePoint, type HiddenUnicodeFinding, scanHiddenUnicode } from '../lib/unicode.js';
import type { ScanContext } from './scan-context.js';
import { joinRel } from './util.js';

const MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

interface SourceFile {
  /** Origin-relative path (shown in messages). */
  rel: string;
  abs: string;
}

/** Most files fit in the first read, so they cost open + read + close (no stat). */
const FIRST_READ_BYTES = 16 * 1024;

/** Text of a file worth checking; undefined for binary, oversized and unreadable files. */
async function readText(abs: string): Promise<string | undefined> {
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

/** Files below the origin-relative directory `rel` (`.` = the root) the walk does not `skip`. */
async function walkedFiles(
  ctx: ScanContext,
  rel: string,
  skip: (name: string, rel: string) => boolean,
): Promise<SourceFile[]> {
  const dirRel = rel === '.' ? '' : rel;
  const walked = await walkFiles(join(ctx.rootAbs, dirRel), { boundary: ctx.rootAbs, skip }).catch(
    () => ({ files: [] }),
  );
  return walked.files.map((f) => ({ rel: joinRel(dirRel, f.rel), abs: f.abs }));
}

/** The plugin-root files a hook's deploy copies (only when its commands reference the root). */
async function hookAssetFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  if (e.def.kind !== 'hook' || !referencesPluginRoot(e.def.hooks.raw)) return [];
  const root = e.def.hooks.pluginRootRel ?? posix.dirname(e.path);
  return walkedFiles(ctx, root, isSkippedHookAsset);
}

async function sourceFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  if (e.kind === 'skill') return walkedFiles(ctx, e.path, (name) => shouldSkipFile(name));
  const rels = [...new Set([e.path, ...(ctx.extraSources.get(e) ?? [])])];
  const own = rels.map((rel) => ({ rel, abs: join(ctx.rootAbs, rel) }));
  const assets = (await hookAssetFiles(ctx, e)).filter((f) => !rels.includes(f.rel));
  return [...own, ...assets];
}

function worstFirst(findings: HiddenUnicodeFinding[]): HiddenUnicodeFinding {
  return (findings.find((f) => f.severity === 'critical') ?? findings[0]) as HiddenUnicodeFinding;
}

function issueFor(file: string, text: string, findings: HiddenUnicodeFinding[]): EntityIssue {
  const first = worstFirst(findings);
  const line = text.slice(0, first.index).split('\n').length;
  return {
    code: 'hidden-unicode',
    severity: first.severity,
    message: `${file}: ${plural(findings.length, 'hidden character')}, first ${describeCodePoint(first.codePoint)} at line ${line}`,
    file,
  };
}

async function fileIssue(file: SourceFile): Promise<EntityIssue | undefined> {
  const text = await readText(file.abs);
  if (text === undefined) return undefined;
  const findings = scanHiddenUnicode(text);
  return findings.length > 0 ? issueFor(file.rel, text, findings) : undefined;
}

async function entityIssues(ctx: ScanContext, e: Entity): Promise<EntityIssue[]> {
  if (e.kind === 'plugin') return [];
  const files = await sourceFiles(ctx, e);
  const issues = await Promise.all(files.map(fileIssue));
  return issues.filter((i): i is EntityIssue => i !== undefined);
}

/** The scan-warning line for an affected entity: its worst file, and how many more there are. */
function warningFor(e: Entity, issues: EntityIssue[]): string {
  const worst = issues.find((i) => i.severity === 'critical') ?? (issues[0] as EntityIssue);
  const more = issues.length > 1 ? `; ${plural(issues.length - 1, 'more file')}` : '';
  return `hidden-unicode: ${e.kind} "${e.name}" (${worst.severity}): ${worst.message}${more}`;
}

/** Check every entity of the scan; attach issues and add one warning line per affected entity. */
export async function checkHiddenUnicode(ctx: ScanContext): Promise<void> {
  const entities = ctx.registry.entities;
  const all = await Promise.all(entities.map((e) => entityIssues(ctx, e)));
  entities.forEach((e, i) => {
    const issues = all[i] ?? [];
    if (issues.length === 0) return;
    e.issues = issues;
    ctx.warnings.push(warningFor(e, issues));
  });
}
