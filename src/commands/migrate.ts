/**
 * `palm migrate [-g] [--dry-run] [--review] [--allow-exec …]` (DESIGN.md §6 "Migrate", PLAN.md
 * §8; palm 0.2 only): turn the palm 0.1 files into the new palm.yaml and lock. `--dry-run`
 * prints the new palm.yaml and writes nothing; otherwise palm lists what it changed and the files
 * to commit, then runs `palm check` on the result and fails when the check fails.
 */
import type { CheckReport, MigrateReport, PalmContext, Scope } from '../core/types.js';
import { plural } from '../lib/text.js';
import { listJoin } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { printFailures } from '../ui/summary.js';
import type { App } from './app.js';
import { printCheck } from './check.js';
import { ExitSignal, type Invocation } from './grammar.js';
import { EXIT } from './main.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

function printReport(out: Output, report: MigrateReport, project: boolean): void {
  out.mark('~', 'palm.yaml and palm.lock.yaml now use the palm 0.2 format');
  for (const s of report.sourcesAdded) out.mark('+', `source ${s} → palm.yaml`);
  for (const a of report.movedAssets) out.mark('~', `moved ${a}`);
  if (report.gitignore) out.mark('~', `.gitignore: ${report.gitignore}`);
  if (report.exec.length) {
    const keys = report.exec.map((u) => u.key).join(', ');
    out.info(
      `${plural(report.exec.length, 'program')} copied again and trusted in the lock: ${keys}`,
    );
  }
  if (!project) return;
  const files = ['palm.yaml', 'palm.lock.yaml'];
  if (report.gitignore) files.push('.gitignore');
  if (report.movedAssets.length) files.push('.palm/assets/');
  out.out(`Commit ${listJoin(files)} together.`);
}

/** A migration ends with `palm check` on what it wrote; a failing check fails the migration. */
async function checkAfter(ctx: PalmContext, app: App, scope: Scope): Promise<CheckReport> {
  const report = await engine(app).checkScope(ctx, { scope }, engineDeps(app));
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
  const report = await engine(app).migrateScope(ctx, { scope, dryRun }, engineDeps(app));
  for (const w of report.warnings) app.out.warn(w);
  if (dryRun && !app.out.jsonMode) app.out.out(report.manifest.trimEnd());
  if (!dryRun && !app.out.jsonMode) printReport(app.out, report, scope === 'project');
  if (!app.out.jsonMode) printFailures(app.out, report.failures);
  const failed = report.failures.length > 0;
  const check = dryRun || failed ? undefined : await checkAfter(ctx, app, scope);
  if (app.out.jsonMode) app.out.json(check ? { ...report, check } : report);
  if (failed || (check && !check.ok)) throw new ExitSignal(EXIT.failure);
}
