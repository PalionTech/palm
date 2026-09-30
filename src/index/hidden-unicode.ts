/**
 * Hidden-Unicode pass (DESIGN §5 "Scan issues"): every text file an entity deploys or runs is
 * checked with `scanHiddenUnicode`. Findings become `Entity.issues` (one per file).
 *
 * Files: a skill's whole directory (a command-skill's file), any other entity's source file(s),
 * every hook file merged into a plugin's hook set, and every file of a hook's or server's closure,
 * so a trojan-source character in a script a hook runs refuses the hook at install.
 */

import type { Entity, EntityIssue } from '../core/types.js';
import { plural } from '../lib/text.js';
import { describeCodePoint, type HiddenUnicodeFinding, scanHiddenUnicode } from '../lib/unicode.js';
import { addIssues } from './issues.js';
import type { ScanContext } from './scan-context.js';
import {
  closureFiles,
  closureOfEntity,
  ownFiles,
  readScannable,
  type SourceFile,
} from './source-files.js';

async function checkedFiles(ctx: ScanContext, e: Entity): Promise<SourceFile[]> {
  const own = await ownFiles(ctx, e);
  const closure = closureOfEntity(e);
  if (!closure) return own;
  const seen = new Set(own.map((f) => f.rel));
  const extra = (await closureFiles(ctx, closure)).filter((f) => !seen.has(f.rel));
  return [...own, ...extra];
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
  const text = await readScannable(file.abs);
  if (text === undefined) return undefined;
  const findings = scanHiddenUnicode(text);
  return findings.length > 0 ? issueFor(file.rel, text, findings) : undefined;
}

async function entityIssues(ctx: ScanContext, e: Entity): Promise<EntityIssue[]> {
  if (e.kind === 'plugin') return [];
  const issues = await Promise.all((await checkedFiles(ctx, e)).map(fileIssue));
  return issues.filter((i): i is EntityIssue => i !== undefined);
}

/** Check every entity of the scan and attach its findings. */
export async function checkHiddenUnicode(ctx: ScanContext): Promise<void> {
  const entities = ctx.registry.entities;
  const all = await Promise.all(entities.map((e) => entityIssues(ctx, e)));
  entities.forEach((e, i) => {
    addIssues(e, all[i] ?? []);
  });
}
