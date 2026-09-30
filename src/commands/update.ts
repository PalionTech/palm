/**
 * `palm update [sources…] [--to ref] [--dry-run] [--review]` (alias `up`), DESIGN.md §6
 * "Update": print the plan (sources, entries, every new or changed program, the files you
 * changed), ask once (default no; `--yes` without a terminal, never for programs), then apply.
 * `--dry-run` is the outdated report; with `--strict` it exits 1 when a source is behind.
 */
import { PalmError } from '../core/errors.js';
import { parseKind } from '../core/kinds.js';
import type {
  ExecUnit,
  PalmContext,
  UpdateMark,
  UpdatePlan,
  UpdatePlanItem,
} from '../core/types.js';
import { gitDiffStat } from '../lib/git-query.js';
import { plural } from '../lib/text.js';
import { formatColumns, listJoin, type Mark, shortHash } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { printFailures } from '../ui/summary.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation, usage } from './grammar.js';
import { exampleLine, palmLine } from './hints.js';
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

/** An unchanged entry with nothing to say (no move, no note): counted, not listed (K21). */
function quiet(i: UpdatePlanItem): boolean {
  return i.mark === 'unchanged' && !i.note && (!i.from || !i.to || i.from === i.to) && !i.exec;
}

/** B21: skipped entries of one source as one line (`⊘ ./kit   100 entries   a directory source…`). */
function skippedLines(items: UpdatePlanItem[]): string[][] {
  const bySource = new Map<string, UpdatePlanItem[]>();
  for (const i of items.filter((x) => x.mark === 'skipped'))
    bySource.set(i.source, [...(bySource.get(i.source) ?? []), i]);
  return [...bySource].map(([source, group]) => {
    const notes = [...new Set(group.flatMap((i) => (i.note ? [i.note] : [])))];
    const n = group.length;
    return ['skipped', 'source', source, `${n} ${n === 1 ? 'entry' : 'entries'}`, notes.join('; ')];
  });
}

function printPlan(out: Output, plan: UpdatePlan, force: boolean): void {
  out.out(`Update plan (${plan.scope} scope)`);
  const sources = plan.sources.map((s) => {
    const latest = s.latest && s.latest !== s.to ? `latest ${s.latest}` : '';
    return [s.name, s.ref, arrow(s.from, s.to), latest];
  });
  for (const line of formatColumns(sources)) out.out(line);
  const listed = plan.items.filter((i) => !quiet(i) && i.mark !== 'skipped');
  const rows = [...listed.map(itemCells), ...skippedLines(plan.items)];
  const marks = [
    ...listed.map((i) => MARKS[i.mark]),
    ...skippedLines(plan.items).map(() => MARKS.skipped),
  ];
  for (const [n, line] of formatColumns(rows).entries()) out.mark(marks[n] ?? '=', line);
  const same = plan.items.filter(quiet).length;
  if (same) out.mark('=', `${same} unchanged`);
  for (const line of plan.items.map(execLine)) if (line) out.mark('!', line);
  printAtRisk(out, plan.items, force);
  printFailures(out, plan.failures);
}

/** D27: `v1.2.3 (6acc160)` as `{ ref, sha }`; `content 1a2b3c4` as `{ content }`. */
function refSha(text: string | undefined): Record<string, string> | undefined {
  if (!text) return undefined;
  const pinned = /^(.*?)\s*\(([0-9a-f]{7,40})\)$/.exec(text);
  if (pinned) return { ...(pinned[1] ? { ref: pinned[1] } : {}), sha: pinned[2] as string };
  const content = /^content ([0-9a-f]+)$/.exec(text);
  if (content) return { content: content[1] as string };
  return /^[0-9a-f]{7,40}$/.test(text) ? { sha: text } : { ref: text };
}

/** The plan as data: versions as fields, not display strings. */
function planJson(plan: UpdatePlan) {
  const versions = <T extends { from?: string; to?: string }>(x: T) => ({
    ...x,
    from: refSha(x.from),
    to: refSha(x.to),
  });
  return { ...plan, sources: plan.sources.map(versions), items: plan.items.map(versions) };
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
  if (out.jsonMode) out.json({ plan: planJson(plan), changes, applied: false });
  else out.hint(changes === 0 ? 'Nothing to update.' : 'dry run: nothing written.');
  const behind = strict && changes > 0;
  if (behind && !out.jsonMode)
    out.info(`--strict exits 1: palm update would apply ${plural(changes, 'change')}`);
  if (plan.failures.length || behind) throw new ExitSignal(1);
}

/** `--to` moves one source; the hint names one palm.yaml declares (D10). */
async function checkArgs(ctx: PalmContext, app: App, sources: string[], flags: UpdateFlags) {
  const [first = ''] = sources;
  const scope = scopeOf(flags);
  if (parseKind(first) && sources.length > 1)
    throw usage('palm update moves sources, not kinds', palmLine('get', ['sources'], scope));
  if (!flags.to || sources.length === 1) return;
  const state = await engine(app).openScope(ctx, scope, { readOnly: true });
  const [declared] = state.sources.names();
  const to = flags.to;
  if (declared)
    throw usage(
      '--to moves the ref of one source',
      palmLine('update', [declared, '--to', to], scope),
    );
  throw usage(
    '--to moves the ref of one source, and palm.yaml declares none',
    exampleLine(
      `palm install <owner/repo>#${to}`,
      palmLine('install', [`mattpocock/skills#${to}`], scope),
    ),
  );
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as UpdateFlags;
  const sources = inv.names.map((n) => n.name);
  // update pages its own review (reviewText); src/exec must not print the scripts again
  const ctx = await makeContext(app, { ...flags, review: false });
  await checkArgs(ctx, app, sources, flags);
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
    if (app.out.jsonMode) app.out.json({ plan: planJson(plan), changes, applied: false });
    else app.out.hint('Nothing changed.');
    return;
  }
  const before = await api.openScope(ctx, opts.scope, { readOnly: true });
  const result = await interruptible(app, () => api.applyUpdate(ctx, plan, opts, engineDeps(app)));
  const after = await api.openScope(ctx, opts.scope, { readOnly: true });
  try {
    await reportInstall(ctx, app, result, {
      before,
      after,
      json: { plan: planJson(plan), ...result },
    });
  } finally {
    // What the update changed, as the review of the commit will show it (DESIGN §6).
    const show = !app.out.jsonMode && opts.scope === 'project';
    const stat = show ? await gitDiffStat(after.paths.root) : undefined;
    if (stat) app.out.out(stat);
  }
}
