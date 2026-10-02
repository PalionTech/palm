/**
 * `palm migrate [-g] [--dry-run] [--review] [--allow-exec …]` (DESIGN.md §6 "Migrate", PLAN.md
 * §8; palm 0.2 only): turn the palm 0.1 files into the new palm.yaml and lock. `--dry-run`
 * prints the new palm.yaml and writes nothing; otherwise palm lists what it changed and the files
 * to commit, then runs `palm check` on the result and fails when the check fails.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPalmError, PalmError } from '../core/errors.js';
import type { CheckReport, MigrateReport, PalmContext, Scope } from '../core/types.js';
import { plural } from '../lib/text.js';
import { listJoin } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { printFailures } from '../ui/summary.js';
import type { App } from './app.js';
import { printCheck } from './check.js';
import { ExitSignal, type Invocation } from './grammar.js';
import { manifestFile, palmLine } from './hints.js';
import { EXIT } from './main.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

/** palm.yaml and the lock first, then the rest as `git status` listed it. */
function commitOrder(files: readonly string[]): string[] {
  const first = ['palm.yaml', 'palm.lock.yaml'].filter((f) => files.includes(f));
  return [...first, ...files.filter((f) => !first.includes(f))];
}

/** The files to commit: the engine's list from `git status`, else palm's own files. */
function toCommit(report: MigrateReport): string[] {
  if (report.commit?.length) return commitOrder(report.commit);
  const files = ['palm.yaml', 'palm.lock.yaml'];
  if (report.gitignore) files.push('.gitignore');
  if (report.movedAssets.length || report.exec.some((u) => !u.closure.inPlace))
    files.push('.palm/assets/');
  return files;
}

/**
 * X8 N15 V5': every file the migration deleted (or would), the files a dry run would write, the
 * 0.1 fragments someone changed and what palm did with them, and the notes the lock keeps.
 */
function printChanges(out: Output, report: MigrateReport, dryRun: boolean): void {
  for (const f of report.written ?? []) out.mark('~', `would write ${f}`);
  for (const r of report.removed ?? [])
    out.mark('-', `${dryRun ? 'would remove' : 'removed'} ${r.file}: ${r.reason}`);
  for (const c of report.changed ?? []) {
    const what = `${c.kind} ${c.name}: ${c.file} (${c.at}) changed since palm 0.1 wrote it`;
    if (c.action === 'replaced') out.mark('~', `${what}; replaced with palm 0.2's render`);
    else if (c.action === 'kept') out.warn(`${what}; kept as you changed it`);
    else out.warn(`${what}; palm migrate asks before replacing it (--force replaces it)`);
  }
  for (const n of report.notes ?? []) out.info(n);
}

/** The engine already said which sources it added to palm.yaml (one line each, L19). */
function printReport(out: Output, report: MigrateReport, project: boolean): void {
  out.mark('~', 'palm.yaml and palm.lock.yaml now use the palm 0.2 format');
  printChanges(out, report, false);
  for (const a of report.movedAssets) out.mark('~', `moved ${a}`);
  if (report.gitignore) out.mark('~', `.gitignore: ${report.gitignore}`);
  // X19: a program that runs in place from the repository was trusted, not copied
  const copied = report.exec.filter((u) => !u.closure.inPlace);
  const inPlace = report.exec.filter((u) => u.closure.inPlace);
  if (copied.length) {
    const keys = copied.map((u) => u.key).join(', ');
    out.info(`${plural(copied.length, 'program')} copied again and trusted in the lock: ${keys}`);
  }
  if (inPlace.length) {
    const keys = inPlace.map((u) => u.key).join(', ');
    out.info(`${plural(inPlace.length, 'program')} trusted in the lock, run in place: ${keys}`);
  }
  const files = project ? toCommit(report) : (report.commit ?? []);
  if (files.length) out.out(`Commit ${listJoin(files)} together.`);
}

/** Hidden-character warnings, which the check after a migration reports again (O20). */
const HIDDEN = /hidden character|ZERO WIDTH|U\+[0-9A-F]{4}/;

/** O20: the migration's warnings the check did not already print for the same entity. */
function unsaid(warnings: readonly string[], check: CheckReport | undefined): string[] {
  const hidden = (check?.checks ?? [])
    .filter((c) => c.id === 'hidden-unicode')
    .flatMap((c) => c.problems.map((p) => (p.entity ? `${p.entity.kind} ${p.entity.name}:` : '')))
    .filter(Boolean);
  return warnings.filter((w) => !(HIDDEN.test(w) && hidden.some((who) => w.startsWith(who))));
}

/** Q10: a migration where neither palm.yaml nor the lock exists says there is nothing here. */
function nothingHere(e: unknown, ctx: PalmContext, scope: Scope): unknown {
  if (!isPalmError(e) || !e.message.startsWith('nothing to migrate')) return e;
  const dir = scope === 'global' ? ctx.paths.palmHome : ctx.paths.projectRoot;
  if (existsSync(join(dir, 'palm.yaml')) || existsSync(join(dir, 'palm.lock.yaml'))) return e;
  const line = palmLine('install', ['mattpocock/skills'], scope);
  return new PalmError(
    'E_USAGE',
    `no ${manifestFile(scope)} here; nothing to migrate`,
    `see what a source offers, for example: ${line}`,
  );
}

/**
 * O2: a project that ignores its output folders on purpose migrates; the check after it prints
 * the re-include lines as a warning instead of failing the migration.
 */
function gitIgnoredWarns(report: CheckReport): CheckReport {
  const checks = report.checks.map((c) =>
    c.id === 'git-ignored' && c.status === 'fail' ? { ...c, status: 'warn' as const } : c,
  );
  return { ...report, checks, ok: checks.every((c) => c.status !== 'fail') };
}

/**
 * A migration ends with `palm check` on what it wrote; a failing check fails the migration. The
 * sources are the ones 0.1 already read on this machine, so a `file://` one outside the project
 * is checked like the migration read it (S4' guards the runs after it).
 */
async function checkAfter(ctx: PalmContext, app: App, scope: Scope): Promise<CheckReport> {
  const own = { ...ctx, flags: { ...ctx.flags, allowLocalSources: true } };
  const report = gitIgnoredWarns(await engine(app).checkScope(own, { scope }, engineDeps(app)));
  if (app.out.jsonMode) return report;
  app.out.out(`\npalm check${scope === 'global' ? ' -g' : ''}:`);
  printCheck(app.out, report, false);
  return report;
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as GlobalOptions;
  const ctx = await makeContext(app, flags);
  const scope = scopeOf(flags);
  const dryRun = ctx.flags.dryRun;
  const report = await engine(app)
    .migrateScope(ctx, { scope, dryRun }, engineDeps(app))
    .catch((e: unknown) => {
      throw nothingHere(e, ctx, scope);
    });
  if (dryRun && !app.out.jsonMode) {
    app.out.out(report.manifest.trimEnd());
    printChanges(app.out, report, true);
  }
  if (!dryRun && !app.out.jsonMode) printReport(app.out, report, scope === 'project');
  if (!app.out.jsonMode) printFailures(app.out, report.failures);
  const failed = report.failures.length > 0;
  const check = dryRun ? undefined : await checkAfter(ctx, app, scope);
  for (const w of unsaid(report.warnings, check)) app.out.warn(w);
  if (app.out.jsonMode) app.out.json(check ? { ...report, check } : report);
  if (failed || (check && !check.ok)) throw new ExitSignal(EXIT.failure);
}
