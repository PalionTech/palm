/**
 * `palm update [kind] [names...]` (alias `up`): print the plan (`~ updated`, `+ added`,
 * `- removed`, `= unchanged`, `x failed`, files at risk), ask y/N (default No; `--yes` for
 * scripts, required without a terminal), then reinstall what changed. `--dry-run` prints the
 * plan only. `palm update origins [alias...]` refreshes origin indexes.
 */
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import type { Kind, PalmContext, Scope, TargetId } from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import type { UpdateMark, UpdatePlan, UpdatePlanItem, UpdateResult } from '../engine/update.js';
import {
  type Mark,
  type Output,
  printFailures,
  printInstallSummary,
  symbol,
} from '../ui/output.js';
import type { App } from './app.js';
import type { Invocation } from './grammar.js';
import { updateOrigins } from './origin.js';
import {
  ExitSignal,
  entityKind,
  failureCount,
  type GlobalOptions,
  makeContext,
  scopeOf,
  withSpinner,
} from './shared.js';

type Ref = { kind?: Kind; name: string };

/** `palm update skills` = every directly installed skill in the scope. */
async function directEntries(ctx: PalmContext, scope: Scope, kind: Kind): Promise<Ref[]> {
  const { listInstalled } = await import('../engine/query.js');
  return (await listInstalled(ctx, scope, kind))
    .filter((e) => !e.via)
    .map((e) => ({ kind: e.kind, name: e.name }));
}

const MARKS: Record<UpdateMark, Mark> = {
  updated: 'updated',
  added: 'added',
  removed: 'removed',
  unchanged: 'unchanged',
  failed: 'error',
  skipped: 'warning',
};

function changeCell(i: UpdatePlanItem): string {
  const change = i.from && i.to ? `${i.from} → ${i.to}` : (i.from ?? '');
  if (!i.note) return change;
  return change ? `${change}  ${pc.dim(i.note)}` : pc.dim(i.note);
}

function planRow(i: UpdatePlanItem): string[] {
  const name = i.via ? `${i.name} ${pc.dim(`(${i.via})`)}` : i.name;
  return [`${symbol(MARKS[i.mark])} ${i.mark}`, i.kind, name, i.origin, changeCell(i)];
}

function printAtRisk(out: Output, items: UpdatePlanItem[], force: boolean): void {
  const risky = items.filter((i) => i.atRisk.length);
  if (!risky.length) return;
  out.out();
  out.out(
    force
      ? `${symbol('warning')} you changed these files; --force overwrites them:`
      : `${symbol('warning')} you changed these files since palm wrote them; palm overwrites them only with --force:`,
  );
  for (const i of risky)
    for (const f of i.atRisk) out.out(`    ${f}  ${pc.dim(`(${i.kind} ${i.name})`)}`);
}

function printPlan(out: Output, plan: UpdatePlan, force: boolean): void {
  out.out(`${pc.bold('Update plan')} ${pc.dim(`(${plan.scope} scope)`)}`);
  out.table(plan.items.map(planRow));
  printAtRisk(out, plan.items, force);
}

function planJson(plan: UpdatePlan): UpdateResult {
  return { plan: plan.items, outcomes: [], failures: plan.failures, warnings: plan.warnings };
}

/** Ask before changing anything: y/N in a terminal, `--yes` without one. False = declined. */
async function confirmed(ctx: PalmContext, changes: number, again: string): Promise<boolean> {
  if (ctx.flags.yes) return true;
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      'palm update changes installed files and needs a confirmation',
      `review the plan, then run: ${again} --yes   (or ${again} --dry-run to only print it)`,
    );
  return ctx.ui.confirm(`Apply ${changes} change${changes === 1 ? '' : 's'}?`, false);
}

/** The command line to repeat in hints: `palm update skill tdd -g`. */
function againCommand(inv: Invocation, scope: Scope): string {
  const words = ['palm update', inv.resource, ...inv.names].filter(Boolean);
  return `${words.join(' ')}${scope === 'global' ? ' -g' : ''}`;
}

async function refsOf(inv: Invocation, ctx: PalmContext, scope: Scope): Promise<Ref[] | undefined> {
  const kind = entityKind(inv.resource, 'update');
  const refs: Ref[] = inv.names.map((n) => ({ kind, name: DepRef.parse(n).name }));
  if (refs.length || !kind) return refs;
  const direct = await directEntries(ctx, scope, kind);
  return direct.length ? direct : undefined;
}

async function applyPlan(ctx: PalmContext, app: App, plan: UpdatePlan): Promise<UpdateResult> {
  const { applyUpdate } = await import('../engine/update.js');
  const step = { message: 'Updating', json: app.out.jsonMode };
  return withSpinner(ctx, step, () => applyUpdate(ctx, plan, app.deps));
}

function printApplied(out: Output, result: UpdateResult, scope: Scope): void {
  const changed = result.outcomes.filter((o) => o.status !== 'unchanged');
  const targets = [...new Set(changed.flatMap((o) => o.entry.targets))] as TargetId[];
  out.out();
  printInstallSummary(out, { ...result, outcomes: changed }, { scope, targets });
}

/** No changes, or --dry-run: the plan is all there is (exit 1 when an origin failed). */
function endWithPlan(out: Output, plan: UpdatePlan, changes: number): void {
  if (out.jsonMode) out.json(planJson(plan));
  else {
    out.hint(changes === 0 ? '\nNothing to update.' : '\ndry run: nothing written');
    printFailures(out, plan.failures);
  }
  for (const w of plan.warnings) out.warn(w);
  if (plan.failures.length) throw new ExitSignal(1);
}

async function makePlan(ctx: PalmContext, app: App, refs: Ref[], scope: Scope) {
  const { planUpdate } = await import('../engine/update.js');
  const step = { message: 'Checking origins for updates', json: app.out.jsonMode };
  return withSpinner(ctx, step, () => planUpdate(ctx, refs, { scope }, app.deps));
}

export async function run(inv: Invocation, app: App): Promise<void> {
  if (inv.resource === 'origin') return updateOrigins(inv, app);
  const g = inv.opts as GlobalOptions;
  const scope = scopeOf(g);
  const ctx = await makeContext(app, g);
  const out = app.out;
  const refs = await refsOf(inv, ctx, scope);
  if (!refs) {
    out.hint(`No ${inv.resource} entries installed in the ${scope} scope.`);
    if (out.jsonMode) out.json({ plan: [], outcomes: [], failures: [] });
    return;
  }
  const plan = await makePlan(ctx, app, refs, scope);
  if (!out.jsonMode) printPlan(out, plan, ctx.flags.force);
  const { planChanges } = await import('../engine/update.js');
  const changes = planChanges(plan);
  if (changes === 0 || ctx.flags.dryRun) return endWithPlan(out, plan, changes);
  if (!(await confirmed(ctx, changes, againCommand(inv, scope)))) {
    out.hint('Nothing changed.');
    return;
  }
  const result = await applyPlan(ctx, app, plan);
  if (out.jsonMode) out.json(result);
  else printApplied(out, result, scope);
  if (failureCount(result)) throw new ExitSignal(1);
}
