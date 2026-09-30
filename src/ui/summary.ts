/**
 * What an install, sync, update or removal prints (DESIGN.md §6 step 11, PLAN.md §4.9): one
 * line per entry (`+ skill  tdd   .agents/skills/tdd/   1 file`), declined programs with the
 * commands that show and install them, the failures on stderr, and a closing count with the
 * commit line on a first install.
 */
import {
  type InstallFailure,
  type InstallOutcome,
  type InstallResult,
  KINDS,
  type LockEntry,
  type LockSource,
  type OutcomeStatus,
  type Scope,
  type TargetId,
} from '../core/types.js';
import { plural } from '../lib/text.js';
import {
  displayLockPath,
  listJoin,
  type Mark,
  padVisible,
  STATUS_MARK,
  shortHash,
  statusWord,
} from './format.js';
import type { Output } from './output.js';

export interface SummaryOptions {
  scope: Scope;
  targets: TargetId[];
  dryRun?: boolean;
  /** The scope had no lock entries before: close with the commit line (project scope). */
  first?: boolean;
  /** Where the targets were detected from (`.claude/`), when this run wrote them to palm.yaml. */
  detected?: string[];
  /** Lock sources, for a `from <source> <version>` cell (installs that named their entities). */
  from?: Record<string, LockSource>;
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

const DECLINED = 'runs a program on your machine; not installed';

interface Row {
  mark: Mark;
  word: string;
  kind: string;
  name: string;
  cells: string[];
  /** Lines under the row (declined programs: how to see and install them). */
  after: string[];
}

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

/** `.claude/skills/tdd/` for a file under a directory named like the entry, else the file. */
function rootOf(lockPath: string, name: string): string {
  const parts = lockPath.split('/');
  const i = parts.lastIndexOf(name);
  if (i >= 0 && i < parts.length - 1) return `${parts.slice(0, i + 1).join('/')}/`;
  return lockPath;
}

function locationOf(e: LockEntry): string {
  const roots: string[] = [];
  const add = (p: string) => {
    const shown = displayLockPath(p);
    if (!roots.includes(shown)) roots.push(shown);
  };
  for (const f of e.files) add(rootOf(f, e.name));
  for (const m of e.merged ?? []) add(m.file);
  if (roots.length <= 2) return roots.join(', ');
  return `${roots.slice(0, 2).join(', ')} +${roots.length - 2}`;
}

function countCell(e: LockEntry): string {
  if (e.files.length) return plural(e.files.length, 'file');
  return e.merged?.length ? 'merged' : '';
}

function fromCell(e: LockEntry, from: SummaryOptions['from']): string {
  const s = from?.[e.source];
  if (!from || !s) return '';
  const version = s.resolved ?? s.ref ?? (s.tree ? `tree ${shortHash(s.tree)}` : '');
  return `from ${e.source}${version ? ` ${version}` : ''}`;
}

function notesCell(o: InstallOutcome): string {
  const partial = Object.entries(o.perTarget ?? {}).map(([t, s]) => `${t}: ${s}`);
  const notes = [...new Set([...partial, ...o.notes])];
  return notes.length ? `(${notes.join('; ')})` : '';
}

function outcomeRow(o: InstallOutcome, opts: SummaryOptions): Row {
  const e = o.entry;
  const base = { kind: e.kind, name: e.name, after: [] };
  if (e.declined) {
    const cmd = `palm install ${e.source} ${e.name}`;
    const after = [`    see it:      ${cmd} --dry-run`, `    install it:  ${cmd}`];
    return { ...base, mark: '!', word: 'declined', cells: [DECLINED], after };
  }
  const word = statusWord(o.status, opts.dryRun);
  if (o.status === 'failed') return { ...base, mark: 'x', word, cells: [] };
  const cells = [locationOf(e), countCell(e), fromCell(e, opts.from), notesCell(o)];
  return { ...base, mark: STATUS_MARK[o.status], word, cells: cells.filter(Boolean) };
}

/** Status order, then kind order; declined programs after the other skips. */
function rank(o: InstallOutcome): number {
  const status = o.entry.declined ? ORDER.indexOf('skipped') + 0.5 : ORDER.indexOf(o.status);
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

function footer(outcomes: InstallOutcome[], opts: SummaryOptions): string | undefined {
  const counted = outcomes.filter((o) => !o.entry.declined);
  const counts = ORDER.map((s) => [s, counted.filter((o) => o.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${statusWord(s, opts.dryRun)}`);
  if (!counts.length) return undefined;
  if (opts.dryRun) return `dry run: ${counts.join(', ')}; nothing written.`;
  const written = counted.filter((o) => o.status === 'installed');
  if (!opts.first || opts.scope !== 'project' || !written.length) return `${counts.join(', ')}.`;
  const dirs = [...new Set(written.flatMap((o) => filesOf(o.entry)).map(topOf))];
  const commit = listJoin(['palm.yaml', 'palm.lock.yaml', ...dirs]);
  return `${counts.join(', ')}. Commit ${commit} together.`;
}

function filesOf(e: LockEntry): string[] {
  return [...e.files, ...(e.merged ?? []).map((m) => m.file)];
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
  const outcomes = sorted(result.outcomes);
  const rows = outcomes.map((o) => outcomeRow(o, opts));
  const words = new Set(rows.filter((r) => r.word !== 'declined').map((r) => r.word));
  printRows(out, rows, words.size > 1 || Boolean(opts.dryRun));
  printFailures(out, result.failures);
  for (const w of result.warnings) out.warn(w);
  const last = footer(outcomes, opts);
  if (last) out.out(last);
}
