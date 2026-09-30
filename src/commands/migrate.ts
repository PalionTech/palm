/**
 * `palm migrate [-g] [--dry-run]` (DESIGN.md §6 "Migrate", PLAN.md §8; palm 0.2 only): turn
 * the palm 0.1 files into the new palm.yaml and lock. `--dry-run` prints the new palm.yaml and
 * writes nothing; otherwise palm lists what it changed and the files to commit.
 */
import type { MigrateReport } from '../core/types.js';
import { plural } from '../lib/text.js';
import { listJoin } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { printFailures } from '../ui/summary.js';
import type { App } from './app.js';
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

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as GlobalOptions;
  const ctx = await makeContext(app, flags);
  const scope = scopeOf(flags);
  const dryRun = ctx.flags.dryRun;
  const report = await engine(app).migrateScope(ctx, { scope, dryRun }, engineDeps(app));
  for (const w of report.warnings) app.out.warn(w);
  if (app.out.jsonMode) app.out.json(report);
  else if (dryRun) app.out.out(report.manifest.trimEnd());
  else printReport(app.out, report, scope === 'project');
  if (!app.out.jsonMode) printFailures(app.out, report.failures);
  if (report.failures.length) throw new ExitSignal(EXIT.failure);
}
