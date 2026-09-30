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
import { listJoin, padVisible, sourceLabel, statusWord, withKind } from './format.js';
import type { Output } from './output.js';
import {
  LEFT_OUT,
  outcomeRow,
  programLeftOut,
  type Row,
  type RowOptions,
  skippedRow,
  wordOf,
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
  /** Q11: the top-level paths the lock held before the run; a new one earns the commit line. */
  known?: ReadonlySet<string>;
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

/** Y3': a row whose notes widen when a harness loads the entity; never collapsed. */
const WIDENS = /always-on for/;

function widens(row: Row): boolean {
  return [...row.cells, ...row.after].some((c) => WIDENS.test(c));
}

interface Widths {
  word: number;
  kind: number;
  name: number;
}

function printRow(out: Output, row: Row, w: Widths, withWord: boolean) {
  const word = withWord ? `${padVisible(row.word, w.word)}  ` : '';
  const tail = row.cells.length ? `   ${row.cells.join('   ')}` : '';
  const line = `${word}${padVisible(row.kind, w.kind)}  ${padVisible(row.name, w.name)}${tail}`;
  out.mark(row.mark, line.trimEnd());
  for (const extra of row.after) out.out(extra);
}

/**
 * `+ skill  brainstorming   .claude/skills/brainstorming/   3 files`; the word column only when
 * statuses mix. More than five installed rows of one kind print the first and `... N more`,
 * except rows whose notes widen activation (Y3').
 */
function printRows(out: Output, rows: Row[], withWord: boolean): void {
  const width = (pick: (r: Row) => string) => Math.max(0, ...rows.map((r) => pick(r).length));
  const w = { word: width((r) => r.word), kind: width((r) => r.kind), name: width((r) => r.name) };
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] as Row;
    const group = rows.slice(i).findIndex((r) => r.word !== row.word || r.kind !== row.kind);
    const size = group < 0 ? rows.length - i : group;
    printRow(out, row, w, withWord);
    const collapse = row.word === statusWord('installed') && size > COLLAPSE_AFTER;
    if (collapse) {
      const rest = rows.slice(i + 1, i + size);
      for (const r of rest.filter(widens)) printRow(out, r, w, withWord);
      const hidden = rest.filter((r) => !widens(r)).length;
      if (hidden) out.out(`  ... ${hidden} more`);
    }
    i += collapse ? size : 1;
  }
}

/**
 * Each failure on stderr: `x kind name from source → target: message`, then its hint with the
 * entity's kind (O3). The same failure twice (one per target) prints once (R14').
 */
export function printFailures(out: Output, failures: readonly InstallFailure[]): void {
  const said = new Set<string>();
  for (const f of failures) {
    const from = sourceLabel(f.source);
    const who =
      f.kind === 'source'
        ? `source ${from}`
        : `${f.kind} ${f.name} from ${from}${f.target ? ` → ${f.target}` : ''}`;
    const hint = f.hint ? withKind(f.hint, f) : f.hint;
    const key = `${who}\u0000${f.message}\u0000${hint ?? ''}`;
    if (said.has(key)) continue;
    said.add(key);
    out.error(`${who}: ${f.message}`, hint);
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

/** `3 installed, 1 overwritten`: one count per word, in status order. */
function countsOf(counted: InstallOutcome[], opts: SummaryOptions): string[] {
  const words = new Map<string, number>();
  for (const s of ORDER)
    for (const o of counted.filter((x) => x.status === s)) {
      const word = wordOf(o, opts);
      words.set(word, (words.get(word) ?? 0) + 1);
    }
  return [...words].map(([word, n]) => `${n} ${word}`);
}

/** Q11: the paths a person commits after this run: all on a first install, else the new ones. */
function toCommit(counted: InstallOutcome[], opts: SummaryOptions): string[] {
  if (opts.scope !== 'project') return [];
  const written = counted.filter((o) => o.status === 'installed');
  const paths = [...new Set(written.flatMap((o) => filesOf(o.entry)).map(topOf))];
  const known = opts.known ?? new Set(paths);
  const fresh = opts.first ? paths : paths.filter((p) => !known.has(p));
  if (!written.length || (!opts.first && !fresh.length)) return [];
  return [...new Set([...(opts.alsoCommit ?? []), ...fresh])];
}

function footer(outcomes: InstallOutcome[], opts: SummaryOptions, failed: boolean) {
  const counted = outcomes.filter((o) => !programLeftOut(o));
  const counts = countsOf(counted, opts);
  if (!counts.length) return opts.named && failed ? 'Nothing installed.' : undefined;
  if (opts.dryRun) return `dry run: ${counts.join(', ')}; nothing written.`;
  const dirs = toCommit(counted, opts);
  if (!dirs.length) return `${counts.join(', ')}.`;
  const commit = listJoin(['palm.yaml', 'palm.lock.yaml', ...dirs]);
  return `${counts.join(', ')}. Commit ${commit} together.`;
}

/**
 * Whether an outcome gets a line: a plugin is a selector over its members, whose lines say it,
 * except a removed plugin (R15': its line says the selector left palm.yaml); an unchanged entry
 * is only counted unless the run named it.
 */
function shown(o: InstallOutcome, named: boolean): boolean {
  if (o.entry.kind === 'plugin') return o.status === 'removed';
  return o.status !== 'unchanged' || named;
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
  const outcomes = sorted(result.outcomes.filter((o) => shown(o, Boolean(opts.named))));
  const rows = rowsOf(outcomes, opts);
  const words = new Set(rows.filter((r) => r.word !== LEFT_OUT).map((r) => r.word));
  printRows(out, rows, words.size > 1 || Boolean(opts.dryRun));
  printFailures(out, result.failures);
  for (const w of result.warnings) out.warn(w);
  const last = footer(counted, opts, result.failures.length > 0);
  if (last) out.out(last);
}
