/**
 * What an install, sync, update or removal prints (DESIGN.md §6 step 11, PLAN.md §4.9): one
 * line per entry that changed (`+ skill  tdd   .agents/skills/tdd/   1 file`), declined programs
 * with the commands that show and install them, the failures on stderr, and a closing count
 * with the commit line on a first install. Unchanged entries are that count only, unless the run
 * named them (K21, B21, D13); every note prints once.
 */
import {
  type InstallFailure,
  type InstallOutcome,
  type InstallResult,
  KINDS,
  type LockEntry,
  type OutcomeStatus,
  type TargetId,
} from '../core/types.js';
import { listJoin, padVisible, statusWord } from './format.js';
import type { Output } from './output.js';
import {
  LEFT_OUT,
  outcomeRow,
  programLeftOut,
  type Row,
  type RowOptions,
  skippedRow,
} from './summary-rows.js';

export interface SummaryOptions extends RowOptions {
  targets: TargetId[];
  /** The scope had no lock entries before: close with the commit line (project scope). */
  first?: boolean;
  /** Where the targets were detected from (`.claude/`), when this run wrote them to palm.yaml. */
  detected?: string[];
  /** More paths the commit line names (the source `palm create` wrote into). */
  alsoCommit?: string[];
  /** The run named its entities: their `=` rows print, and a run that installs none says so. */
  named?: boolean;
}

/** Statuses in the order their lines print. */
const ORDER: readonly OutcomeStatus[] = [
  'installed',
  'updated',
  're-rendered',
  'restored',
  'unchanged',
  'removed',
  'skipped',
  'modified',
  'partial',
  'failed',
];

/** A group of one status and kind longer than this prints its first line and `... N more`. */
const COLLAPSE_AFTER = 5;

/**
 * How many things an engine result reports as failed: its `failures`, or outcomes that failed,
 * are partial or kept a modified file. The CLI exits 1 when this is not 0.
 */
export function failureCount(result: object): number {
  const r = result as { failures?: unknown; outcomes?: Array<{ status?: string }> };
  const listed = Array.isArray(r.failures) ? r.failures.length : 0;
  const bad = (r.outcomes ?? []).filter(
    (o) => o.status === 'failed' || o.status === 'partial' || o.status === 'modified',
  ).length;
  return Math.max(listed, bad);
}

/** The top-level directory (or root file) a lock path lives in: `.claude/`, `AGENTS.md`. */
function topOf(lockPath: string): string {
  const i = lockPath.indexOf('/');
  return i < 0 ? lockPath : lockPath.slice(0, i + 1);
}

/** Status order, then kind order; declined programs after the other skips. */
function rank(o: InstallOutcome): number {
  const status = programLeftOut(o) ? ORDER.indexOf('skipped') + 0.5 : ORDER.indexOf(o.status);
  return status * 100 + KINDS.indexOf(o.entry.kind);
}

function sorted(outcomes: InstallOutcome[]): InstallOutcome[] {
  return outcomes
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
    .map(({ o }) => o);
}

/** `+ skill  brainstorming   .claude/skills/brainstorming/   3 files`; the word column only when statuses mix. */
function printRows(out: Output, rows: Row[], withWord: boolean): void {
  const width = (pick: (r: Row) => string) => Math.max(0, ...rows.map((r) => pick(r).length));
  const [ww, kw, nw] = [width((r) => r.word), width((r) => r.kind), width((r) => r.name)];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] as Row;
    const group = rows.slice(i).findIndex((r) => r.word !== row.word || r.kind !== row.kind);
    const size = group < 0 ? rows.length - i : group;
    const word = withWord ? `${padVisible(row.word, ww)}  ` : '';
    const tail = row.cells.length ? `   ${row.cells.join('   ')}` : '';
    const line = `${word}${padVisible(row.kind, kw)}  ${padVisible(row.name, nw)}${tail}`;
    out.mark(row.mark, line.trimEnd());
    for (const extra of row.after) out.out(extra);
    const collapse = row.word === statusWord('installed') && size > COLLAPSE_AFTER;
    if (collapse) out.out(`  ... ${size - 1} more`);
    i += collapse ? size : 1;
  }
}

/** Each failure on stderr: `x kind name from source → target: message`, then its hint. */
export function printFailures(out: Output, failures: readonly InstallFailure[]): void {
  for (const f of failures) {
    const who =
      f.kind === 'source'
        ? `source ${f.source}`
        : `${f.kind} ${f.name} from ${f.source}${f.target ? ` → ${f.target}` : ''}`;
    out.error(`${who}: ${f.message}`, f.hint);
  }
}

function targetsLine(opts: SummaryOptions): string {
  const manifest = opts.scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  const where = opts.dryRun ? `not saved: dry run` : `change targets: in ${manifest}`;
  return `targets: ${opts.targets.join(', ')}   (detected from ${listJoin(opts.detected ?? [])}; ${where})`;
}

function filesOf(e: LockEntry): string[] {
  return [...e.files, ...(e.merged ?? []).map((m) => m.file)];
}

function footer(outcomes: InstallOutcome[], opts: SummaryOptions, failed: boolean) {
  const counted = outcomes.filter((o) => !programLeftOut(o));
  const counts = ORDER.map((s) => [s, counted.filter((o) => o.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${statusWord(s, opts.dryRun)}`);
  if (!counts.length) return opts.named && failed ? 'Nothing installed.' : undefined;
  if (opts.dryRun) return `dry run: ${counts.join(', ')}; nothing written.`;
  const written = counted.filter((o) => o.status === 'installed');
  if (!opts.first || opts.scope !== 'project' || !written.length) return `${counts.join(', ')}.`;
  const paths = written.flatMap((o) => filesOf(o.entry)).map(topOf);
  const dirs = [...new Set([...(opts.alsoCommit ?? []), ...paths])];
  const commit = listJoin(['palm.yaml', 'palm.lock.yaml', ...dirs]);
  return `${counts.join(', ')}. Commit ${commit} together.`;
}

/**
 * Whether an outcome gets a line: a plugin is a selector over its members, whose lines say it;
 * a program declined earlier stays quiet on later runs (it was reported when it was declined);
 * an unchanged entry is only counted unless the run named it.
 */
function shown(o: InstallOutcome, named: boolean): boolean {
  if (o.entry.kind === 'plugin') return false;
  if (o.status !== 'unchanged') return true;
  return named && !o.entry.declined;
}

/** Rows in print order: skipped entries of one source (not programs) share one row. */
function rowsOf(outcomes: InstallOutcome[], opts: SummaryOptions): Row[] {
  const said = new Set<string>();
  const skipped = (o: InstallOutcome) => o.status === 'skipped' && !programLeftOut(o);
  const bySource = new Map<string, InstallOutcome[]>();
  for (const o of outcomes.filter(skipped))
    bySource.set(o.entry.source, [...(bySource.get(o.entry.source) ?? []), o]);
  const rows: Row[] = [];
  for (const o of outcomes) {
    const group = skipped(o) ? (bySource.get(o.entry.source) ?? []) : [];
    if (group.length > 1 && group[0] !== o) continue;
    if (group.length > 1) rows.push(skippedRow(o.entry.source, group, said));
    else rows.push(outcomeRow(o, opts, said));
  }
  return rows;
}

/**
 * The status lines of an install, sync, update or removal, then its failures (stderr), then the
 * closing count. Result warnings join the collected warnings. Under `dryRun` the statuses say
 * what would happen (`would install`).
 */
export function printInstallSummary(
  out: Output,
  result: InstallResult,
  opts: SummaryOptions,
): void {
  if (opts.detected?.length && opts.targets.length) out.out(targetsLine(opts));
  const counted = result.outcomes.filter((o) => o.entry.kind !== 'plugin');
  const outcomes = sorted(counted.filter((o) => shown(o, Boolean(opts.named))));
  const rows = rowsOf(outcomes, opts);
  const words = new Set(rows.filter((r) => r.word !== LEFT_OUT).map((r) => r.word));
  printRows(out, rows, words.size > 1 || Boolean(opts.dryRun));
  printFailures(out, result.failures);
  for (const w of result.warnings) out.warn(w);
  const quiet = (o: InstallOutcome) => o.entry.declined && o.status === 'unchanged';
  const last = footer(
    counted.filter((o) => !quiet(o)),
    opts,
    result.failures.length > 0,
  );
  if (last) out.out(last);
}
