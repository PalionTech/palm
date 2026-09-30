/**
 * `palm update [sources…] [--to ref] [--dry-run] [--review]` (alias `up`), DESIGN.md §6
 * "Update": print the plan (sources, entries, every new or changed program, the files you
 * changed), ask once (default no; `--yes` without a terminal, never for programs), then apply.
 * `--dry-run` is the outdated report; with `--strict` it exits 1 when a source is behind.
 */
import { PalmError } from '../core/errors.js';
import type {
  ExecUnit,
  PalmContext,
  UpdateMark,
  UpdatePlan,
  UpdatePlanItem,
} from '../core/types.js';
import { plural } from '../lib/text.js';
import { formatColumns, listJoin, type Mark, shortHash } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { printFailures } from '../ui/summary.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation, usage } from './grammar.js';
import { parseKind } from './ports.js';
import { interruptible, reportInstall } from './report.js';
import {
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  scopeOf,
  withSpinner,
} from './shared.js';

interface UpdateFlags extends GlobalOptions {
  to?: string;
  review?: boolean;
  strict?: boolean;
}

const MARKS: Readonly<Record<UpdateMark, Mark>> = {
  updated: '~',
  added: '+',
  removed: '-',
  unchanged: '=',
  failed: 'x',
  skipped: '⊘',
};

const arrow = (from?: string, to?: string) =>
  from && to && from !== to ? `${from} → ${to}` : (to ?? from ?? '');

function itemCells(i: UpdatePlanItem): string[] {
  const name = i.via ? `${i.name} (${i.via})` : i.name;
  const change = [arrow(i.from, i.to), i.note].filter(Boolean).join('  ');
  return [i.mark, i.kind, name, i.source, change];
}

function changedScripts(before: ExecUnit, after: ExecUnit): string[] {
  const known = new Map(before.closure.files.map((f) => [f.path, f.hash]));
  return after.closure.files.filter((f) => known.get(f.path) !== f.hash).map((f) => f.path);
}

/** `hook team-skills: setup.sh changed (sha256:a7cc7911… → 3e01a9f2…); d shows the diff`. */
function execLine(i: UpdatePlanItem): string | undefined {
  if (!i.exec) return undefined;
  const { unit, previous } = i.exec;
  const hash = (u: ExecUnit) => `sha256:${shortHash(u.hash, 8)}…`;
  if (!previous)
    return `${i.kind} ${i.name}: a new program (${hash(unit)}); palm asks before it lands`;
  const scripts = changedScripts(previous, unit);
  const what = scripts.length ? `${listJoin(scripts)} changed` : 'its command changed';
  return `${i.kind} ${i.name}: ${what} (${hash(previous)} → ${shortHash(unit.hash, 8)}…); d shows the diff`;
}

function printAtRisk(out: Output, items: UpdatePlanItem[], force: boolean): void {
  const risky = items.filter((i) => i.atRisk.length);
  if (!risky.length) return;
  const how = force ? '--force overwrites them' : 'palm overwrites them only with --force';
  out.mark('!', `you changed these files since palm wrote them; ${how}:`);
  for (const i of risky) for (const f of i.atRisk) out.out(`    ${f}  (${i.kind} ${i.name})`);
}

function printPlan(out: Output, plan: UpdatePlan, force: boolean): void {
  out.out(`Update plan (${plan.scope} scope)`);
  for (const line of formatColumns(plan.sources.map((s) => [s.name, s.ref, arrow(s.from, s.to)])))
    out.out(line);
  const lines = formatColumns(plan.items.map(itemCells));
  for (const [n, item] of plan.items.entries()) out.mark(MARKS[item.mark], lines[n] ?? '');
  for (const line of plan.items.map(execLine)) if (line) out.mark('!', line);
  printAtRisk(out, plan.items, force);
  printFailures(out, plan.failures);
}

async function confirmed(ctx: PalmContext, changes: number): Promise<boolean> {
  if (ctx.flags.yes) return true;
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `palm update would apply ${plural(changes, 'change')} and there is no terminal to ask`,
      'review it with --dry-run, then apply it',
      { retryWith: '--yes' },
    );
  return ctx.ui.confirm(`Apply ${plural(changes, 'change')}?`, false);
}

/** No changes, or --dry-run: the plan is all there is. */
function endWithPlan(app: App, plan: UpdatePlan, changes: number, strict: boolean): void {
  const out = app.out;
  for (const w of plan.warnings) out.warn(w);
  if (out.jsonMode) out.json({ plan, changes, applied: false });
  else out.hint(changes === 0 ? 'Nothing to update.' : 'dry run: nothing written.');
  if (plan.failures.length || (strict && changes > 0)) throw new ExitSignal(1);
}

function checkArgs(sources: string[], flags: UpdateFlags): void {
  const [first = ''] = sources;
  if (parseKind(first) && sources.length > 1)
    throw usage('palm update moves sources, not kinds', 'palm get sources');
  if (flags.to && sources.length !== 1)
    throw usage(
      '--to moves the ref of one source',
      `palm update mattpocock/skills --to ${flags.to}`,
    );
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as UpdateFlags;
  const sources = inv.names.map((n) => n.name);
  checkArgs(sources, flags);
  const ctx = await makeContext(app, flags);
  const api = engine(app);
  const opts = { scope: scopeOf(flags), ...(flags.to ? { to: flags.to } : {}) };
  const plan = await withSpinner(ctx, 'Checking sources for updates', () =>
    api.planUpdate(ctx, sources, opts, engineDeps(app)),
  );
  const changes = await api.planChanges(plan);
  if (!app.out.jsonMode) printPlan(app.out, plan, ctx.flags.force);
  if (flags.review)
    await app.out.page(
      await api.reviewText(ctx, plan, await api.resolveEngineDeps(engineDeps(app))),
    );
  if (ctx.flags.dryRun || changes === 0)
    return endWithPlan(app, plan, changes, Boolean(flags.strict));
  if (!(await confirmed(ctx, changes))) {
    if (app.out.jsonMode) app.out.json({ plan, changes, applied: false });
    else app.out.hint('Nothing changed.');
    return;
  }
  const before = await api.openScope(ctx, opts.scope, { readOnly: true });
  const result = await interruptible(app, () => api.applyUpdate(ctx, plan, opts, engineDeps(app)));
  const after = await api.openScope(ctx, opts.scope, { readOnly: true });
  await reportInstall(ctx, app, result, { before, after, json: { plan, ...result } });
}
