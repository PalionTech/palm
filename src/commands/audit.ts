/**
 * `palm audit [kind] [names...] [-g] [--strip] [--json]`: scans the files palm installed (every
 * lock entry's `files`; the project and the global scope, only the global one with -g) for hidden
 * Unicode (src/lib/unicode.ts) and for drift from the lock (a file missing, or changed since
 * install when the lock recorded its hash).
 *
 * Exit codes: 0 when nothing critical is left (warnings and drift are printed, not failures),
 * 1 when a critical finding remains. `--strip` removes every finding (critical and warning) from
 * the files it scanned and records their new hashes, so a stripped install audits clean.
 */
import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { hashPath } from '../core/hash.js';
import { parseKind } from '../core/kinds.js';
import { isHomeAsProject } from '../core/paths.js';
import type { Kind, LockEntry, PalmContext, Scope } from '../core/types.js';
import { answersTo, Lock } from '../domain/lock.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isEnoent, writeFileAtomic } from '../lib/fs.js';
import {
  describeCodePoint,
  type HiddenUnicodeSeverity,
  scanHiddenUnicode,
  stripHiddenUnicode,
} from '../lib/unicode.js';
import type { Mark, Output } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation } from './grammar.js';
import { displayPath, type GlobalOptions, makeContext } from './shared.js';

export interface AuditOptions {
  /** Scopes to scan, in order. */
  scopes: Scope[];
  kind?: Kind;
  /** Entity names (or registry names) to keep; all entries when empty. */
  names?: string[];
  /** Remove the findings from the files (not with `ctx.flags.dryRun`). */
  strip?: boolean;
}

export interface AuditFinding {
  severity: HiddenUnicodeSeverity;
  codePoint: number;
  name: string;
  /** 1-based line and column (UTF-16 units) of the character. */
  line: number;
  column: number;
}

/** A file with hidden Unicode or drift; clean files are only counted. */
export interface AuditedFile {
  scope: Scope;
  /** As the lock lists it: project-relative, or absolute at global scope. */
  path: string;
  abs: string;
  /** `kind name@origin` of the entry that wrote it. */
  entity: string;
  findings: AuditFinding[];
  /** `missing`: gone from disk; `modified`: differs from the hash recorded at install. */
  drift?: 'missing' | 'modified';
  /** Characters `--strip` removed (or would remove, in a dry run). */
  stripped?: number;
}

export interface AuditReport {
  scanned: number;
  files: AuditedFile[];
  /** Findings of each severity still in the files (after `--strip`, none). */
  remaining: { critical: number; warning: number };
  /** Files missing or changed since install. */
  drifted: number;
}

/** A lock `files` item: lockfile v2 `{ path, hash }`, or a v1 path string (hash unknown). */
type LockFileItem = string | { path: string; hash?: string };

function fileItem(item: LockFileItem): { path: string; hash: string } {
  return typeof item === 'string'
    ? { path: item, hash: '' }
    : { path: item.path, hash: item.hash ?? '' };
}

/** Text is a file without a NUL byte in its first 8 KB (git's heuristic); binaries are skipped. */
function isText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

function position(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lastNl = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: index - lastNl };
}

function findingsIn(text: string): AuditFinding[] {
  return scanHiddenUnicode(text).map((f) => ({
    severity: f.severity,
    codePoint: f.codePoint,
    name: f.name,
    ...position(text, f.index),
  }));
}

interface Scanned {
  file: AuditedFile;
  /** The file's hash after --strip rewrote it, when the lock should record it. */
  newHash?: string;
}

async function readBytes(abs: string): Promise<Buffer | undefined> {
  try {
    return await readFile(abs);
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/** Rewrites `abs` without its findings; the new hash when the lock's hash matched before. */
async function stripFile(abs: string, text: string, lockedHash: string, intact: boolean) {
  await writeFileAtomic(abs, stripHiddenUnicode(text));
  return lockedHash && intact ? hashPath(abs) : undefined;
}

async function scanFile(
  ctx: PalmContext,
  file: AuditedFile,
  lockedHash: string,
  opts: AuditOptions,
): Promise<Scanned | undefined> {
  const bytes = await readBytes(file.abs);
  if (!bytes) return { file: { ...file, drift: 'missing' } };
  const intact = !lockedHash || lockedHash === (await hashPath(file.abs));
  const out: AuditedFile = intact ? file : { ...file, drift: 'modified' };
  const findings = isText(bytes) ? findingsIn(bytes.toString('utf8')) : [];
  if (!findings.length) return intact ? undefined : { file: out };
  if (!opts.strip) return { file: { ...out, findings } };
  const stripped = { ...out, findings, stripped: findings.length };
  if (ctx.flags.dryRun) return { file: stripped };
  const newHash = await stripFile(file.abs, bytes.toString('utf8'), lockedHash, intact);
  return newHash ? { file: stripped, newHash } : { file: stripped };
}

function entityLabel(e: LockEntry): string {
  return `${e.kind} ${e.name}@${e.origin}`;
}

function selected(e: LockEntry, opts: AuditOptions): boolean {
  if (opts.kind && e.kind !== opts.kind) return false;
  return !opts.names?.length || opts.names.some((n) => answersTo(e, n));
}

interface ScopeAudit {
  scanned: number;
  files: AuditedFile[];
  /** Lock entries whose file hashes --strip changed. */
  rehashed: LockEntry[];
}

async function auditEntry(
  ctx: PalmContext,
  sp: ScopePaths,
  entry: LockEntry,
  opts: AuditOptions,
): Promise<ScopeAudit> {
  const result: ScopeAudit = { scanned: 0, files: [], rehashed: [] };
  const items = (entry.files as LockFileItem[]).map(fileItem);
  let changed = false;
  for (const item of items) {
    const abs = sp.safeAbs(item.path);
    if (!abs) continue; // outside the scope: never read or written (a tampered lock)
    result.scanned++;
    const base = {
      scope: sp.scope,
      path: item.path,
      abs,
      entity: entityLabel(entry),
      findings: [],
    };
    const scanned = await scanFile(ctx, base, item.hash, opts);
    if (!scanned) continue;
    result.files.push(scanned.file);
    if (scanned.newHash) {
      item.hash = scanned.newHash;
      changed = true;
    }
  }
  if (changed) result.rehashed.push({ ...entry, files: items } as LockEntry);
  return result;
}

async function auditScope(ctx: PalmContext, scope: Scope, opts: AuditOptions): Promise<ScopeAudit> {
  const sp = ScopePaths.of(ctx, scope);
  const lock = await Lock.load(sp.lockFile);
  const total: ScopeAudit = { scanned: 0, files: [], rehashed: [] };
  for (const entry of lock.entries.filter((e) => selected(e, opts))) {
    const r = await auditEntry(ctx, sp, entry, opts);
    total.scanned += r.scanned;
    total.files.push(...r.files);
    total.rehashed.push(...r.rehashed);
  }
  if (total.rehashed.length) {
    for (const e of total.rehashed) lock.upsert(e);
    await lock.save(sp.lockFile);
  }
  return total;
}

/** Findings of `severity` still on disk: all of them in a dry run, else those not stripped. */
function countRemaining(files: AuditedFile[], severity: HiddenUnicodeSeverity, dryRun: boolean) {
  return files
    .filter((f) => dryRun || f.stripped === undefined)
    .reduce((n, f) => n + f.findings.filter((x) => x.severity === severity).length, 0);
}

/** Scans (and with `strip`, cleans) the palm-owned files of each scope's lock. */
export async function runAudit(ctx: PalmContext, opts: AuditOptions): Promise<AuditReport> {
  const report: AuditReport = {
    scanned: 0,
    files: [],
    remaining: { critical: 0, warning: 0 },
    drifted: 0,
  };
  for (const scope of opts.scopes) {
    const r = await auditScope(ctx, scope, opts);
    report.scanned += r.scanned;
    report.files.push(...r.files);
  }
  report.remaining.critical = countRemaining(report.files, 'critical', ctx.flags.dryRun);
  report.remaining.warning = countRemaining(report.files, 'warning', ctx.flags.dryRun);
  report.drifted = report.files.filter((f) => f.drift).length;
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface AuditCliOptions extends GlobalOptions {
  strip?: boolean;
}

/** `[kind] [names...]`: a first word that is no entity kind is a name. */
function parseTargets(names: string[]): { kind?: Kind; names: string[] } {
  const kind = parseKind(names[0]);
  return kind ? { kind, names: names.slice(1) } : { names };
}

function scopesFor(ctx: PalmContext, g: GlobalOptions): Scope[] {
  if (g.global || isHomeAsProject(ctx.paths, ctx.env)) return ['global'];
  return ['project', 'global'];
}

function severityCounts(f: AuditedFile): string {
  const crit = f.findings.filter((x) => x.severity === 'critical').length;
  const warn = f.findings.length - crit;
  const parts = [
    crit && pc.red(`${crit} critical`),
    warn && `${warn} warning${warn === 1 ? '' : 's'}`,
  ];
  return parts.filter(Boolean).join(', ');
}

function findingLine(f: AuditedFile, first: AuditFinding, dryRun: boolean): string {
  if (f.stripped !== undefined)
    return `${dryRun ? 'would remove' : 'removed'} ${plural(f.stripped, 'hidden character')}`;
  return `${severityCounts(f)}; first: ${describeCodePoint(first.codePoint)} at ${first.line}:${first.column}`;
}

function printFile(ctx: PalmContext, out: Output, f: AuditedFile, dryRun: boolean): void {
  const where = `${displayPath(ctx, f.abs)} ${pc.dim(`(${f.entity})`)}`;
  if (f.drift)
    out.mark('warning', `${where}: ${f.drift === 'missing' ? 'missing' : 'changed since install'}`);
  const first = f.findings[0];
  if (!first) return;
  const critical = f.findings.some((x) => x.severity === 'critical');
  let mark: Mark = critical ? 'error' : 'warning';
  if (f.stripped !== undefined) mark = 'updated';
  out.mark(mark, `${where}: ${findingLine(f, first, dryRun)}`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function printSummary(out: Output, r: AuditReport, g: AuditCliOptions, dryRun: boolean): void {
  const hidden = r.files.filter((f) => f.findings.length && f.stripped === undefined).length;
  const cleaned = r.files.filter((f) => f.stripped !== undefined).length;
  const parts = [`${plural(r.scanned, 'file')} scanned`];
  if (cleaned) parts.push(`${dryRun ? 'would clean' : 'cleaned'} ${plural(cleaned, 'file')}`);
  if (hidden) parts.push(`${hidden} with hidden Unicode`);
  if (r.drifted) parts.push(`${r.drifted} changed or missing since install`);
  if (parts.length === 1) parts.push('no hidden Unicode');
  out.info(parts.join('; '));
  if (hidden) out.hint(`remove the hidden characters: palm audit${g.global ? ' -g' : ''} --strip`);
  if (r.drifted) out.hint('restore them: palm install --force   (add -g for global files)');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const g = inv.opts as AuditCliOptions;
  const ctx = await makeContext(app, g, { interactive: false });
  const { kind, names } = parseTargets(inv.names);
  const opts: AuditOptions = { scopes: scopesFor(ctx, g), names, strip: Boolean(g.strip) };
  if (kind) opts.kind = kind;
  const report = await runAudit(ctx, opts);
  if (app.out.jsonMode) app.out.json(report);
  else {
    for (const f of report.files) printFile(ctx, app.out, f, ctx.flags.dryRun);
    printSummary(app.out, report, g, ctx.flags.dryRun);
  }
  if (report.remaining.critical > 0) throw new ExitSignal(1);
}
