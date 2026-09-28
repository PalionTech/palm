/**
 * Hidden-Unicode pass (PLAN §2 item 11, DESIGN §5 "Scan issues"): every text file an entity
 * deploys is checked with `scanHiddenUnicode`. Findings become `Entity.issues` (one per file) and
 * one `hidden-unicode:` line per affected entity in the scan warnings.
 *
 * Files: a skill's whole directory, walked like the deploy copy walks it (COPY_SKIP, symlinks only
 * inside the origin); any other entity's source file(s). Binary files (a NUL byte in the first
 * 8 KB) and files over 1 MB are skipped.
 */

import { type FileHandle, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entity, EntityIssue } from '../core/types.js';
import { shouldSkipFile } from '../domain/ignore.js';
import { walkFiles } from '../lib/fs.js';
import { describeCodePoint, type HiddenUnicodeFinding, scanHiddenUnicode } from '../lib/unicode.js';
import type { ScanContext } from './scan-context.js';
import { joinRel } from './util.js';

const MAX_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

/**
 * Cheap pre-check, a superset of what `scanHiddenUnicode` reports (format characters, the
 * invisible fillers, tag characters, supplementary variation selectors): most files contain none
 * of these, and the native regex spares them the per-code-point scan. test/index/hidden-unicode
 * checks the superset property over the planes where such characters live.
 */
export const MAY_HIDE_UNICODE =
  /[\p{Cf}\u115f\u1160\u3164\uffa0\u{E0000}-\u{E007F}]|\u034f|[\u{E0100}-\u{E01EF}]/u;

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

async function sourceFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  if (e.kind === 'skill') {
    const dirRel = e.path === '.' ? '' : e.path;
    const walked = await walkFiles(join(ctx.rootAbs, dirRel), {
      boundary: ctx.rootAbs,
      skip: (name) => shouldSkipFile(name),
    }).catch(() => ({ files: [] }));
    return walked.files.map((f) => ({ rel: joinRel(dirRel, f.rel), abs: f.abs }));
  }
  const rels = [...new Set([e.path, ...(ctx.extraSources.get(e) ?? [])])];
  return rels.map((rel) => ({ rel, abs: join(ctx.rootAbs, rel) }));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  if (!MAY_HIDE_UNICODE.test(text)) return undefined;
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
