/**
 * The rows of an install summary (src/ui/summary.ts): one per entry that changed, programs left
 * out with the commands that show and install them, skipped entries of one source as one row,
 * and every note once.
 */
import type { InstallOutcome, LockEntry, LockSource, Scope } from '../core/types.js';
import { plural } from '../lib/text.js';
import {
  displayLockPath,
  type Mark,
  STATUS_MARK,
  shortHash,
  shortRef,
  sourceLabel,
  statusWord,
} from './format.js';

export interface RowOptions {
  scope: Scope;
  dryRun?: boolean;
  /** Lock sources, for a `from <source> <version>` cell (installs that named their entities). */
  from?: Record<string, LockSource>;
  /** The source as a pasteable command names it (K9): the key once declared, else as typed. */
  sourceWord?: (source: string) => string;
  /** Y18': the run had --force: a restored edit reads `overwritten`. */
  forced?: boolean;
  /** Y16': the entry as the lock held it before the run (its targets). */
  before?: (e: LockEntry) => LockEntry | undefined;
  /** E5': an in-repo source's directory as a person types it; undefined for a git source. */
  localSource?: (source: string) => string | undefined;
  /** Q12: sources this run moved to an older version. */
  downgraded?: (source: string) => boolean;
}

/** The word an outcome reads with: `overwritten` under --force (Y18'), `downgraded` (Q12). */
export function wordOf(o: InstallOutcome, opts: RowOptions): string {
  if (opts.forced && o.status === 'restored')
    return opts.dryRun ? 'would overwrite' : 'overwritten';
  if (o.status === 'updated' && opts.downgraded?.(o.entry.source))
    return opts.dryRun ? 'would downgrade' : 'downgraded';
  return statusWord(o.status, opts.dryRun);
}

export interface Row {
  mark: Mark;
  word: string;
  kind: string;
  name: string;
  cells: string[];
  /** Lines under the row (declined programs: how to see and install them). */
  after: string[];
}

const DECLINED = 'runs a program on your machine; not installed';
/** The status word of a program this run left out, when the table shows status words. */
export const LEFT_OUT = 'not installed';

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

/** K22: `2 files`, `1 file +1 merged`, `merged`. */
function countCell(e: LockEntry): string {
  const merged = e.merged?.length ?? 0;
  if (!e.files.length) return merged ? 'merged' : '';
  return `${plural(e.files.length, 'file')}${merged ? ` +${merged} merged` : ''}`;
}

function fromCell(e: LockEntry, from: RowOptions['from']): string {
  const s = from?.[e.source];
  if (!from || !s) return '';
  const version = shortRef(s.resolved ?? s.ref) ?? (s.tree ? `tree ${shortHash(s.tree)}` : '');
  return `from ${sourceLabel(e.source)}${version ? ` ${version}` : ''}`;
}

/** Notes that fit in the row's last cell: `(cursor reads .agents/skills)`. */
const INLINE_NOTE = 60;

/** Y16': `removed from claude, opencode` when the run narrowed the entry's targets. */
function narrowed(o: InstallOutcome, opts: RowOptions): string[] {
  const was = opts.before?.(o.entry);
  if (!was || o.status === 'removed') return [];
  const gone = Object.keys(was.render).filter((t) => !(t in o.entry.render));
  const verb = opts.dryRun ? 'would be removed from' : 'removed from';
  return gone.length ? [`${verb} ${gone.join(', ')}`] : [];
}

/** The row's notes not printed on an earlier row; per-target words say `would …` in a dry run. */
function notesOf(o: InstallOutcome, opts: RowOptions, said: Set<string>): string[] {
  const perTarget = Object.entries(o.perTarget ?? {}).map(
    ([t, s]) => `${t}: ${statusWord(s, opts.dryRun)}`,
  );
  const notes = [...perTarget, ...narrowed(o, opts), ...o.notes];
  const fresh = [...new Set(notes)].filter((n) => !said.has(n));
  for (const n of fresh) if (!perTarget.includes(n)) said.add(n);
  return fresh;
}

/**
 * A program this run did not install: declined at the consent prompt or left out by `--all`
 * (`declined`), or skipped with an exec unit nobody trusted yet.
 */
export function programLeftOut(o: InstallOutcome): boolean {
  const e = o.entry;
  if (o.declined) return true;
  return o.status === 'skipped' && e.exec !== undefined && !e.trust?.includes(e.exec.hash);
}

/** J10: a server declared in palm.yaml installs with a bare install, not from a source named `manifest`. */
function programHints(e: LockEntry, opts: RowOptions): string[] {
  const g = opts.scope === 'global' ? ' -g' : '';
  if (sourceLabel(e.source) === 'palm.yaml')
    return [
      `    see it:      palm install --dry-run --review${g}`,
      `    install it:  palm install${g}`,
    ];
  const source = opts.sourceWord?.(e.source) ?? e.source;
  const cmd = `palm install ${source} ${e.kind}:${e.name}`;
  return [`    see it:      ${cmd} --dry-run${g}`, `    install it:  ${cmd}${g}`];
}

/**
 * O17, R2', E5': how to keep a kept edit for good. From an in-repo source: make it in the
 * source file; from any other source: copy it into your own source under a new name. The
 * failure's `--force` line discards it.
 */
function keepItLine(e: LockEntry, opts: RowOptions): string {
  const dir = opts.localSource?.(e.source);
  const g = opts.scope === 'global' ? ' -g' : '';
  if (dir)
    return `    to keep your change, make it in ${dir}/${e.path}, then run: palm install${g}`;
  const where = locationOf(e).split(', ')[0];
  return `    to keep your change, copy ${where} into your own source under a new name; --force discards it`;
}

export function outcomeRow(o: InstallOutcome, opts: RowOptions, said: Set<string>): Row {
  const e = o.entry;
  const base = { kind: e.kind, name: e.name, after: [] as string[] };
  if (programLeftOut(o))
    return { ...base, mark: '!', word: LEFT_OUT, cells: [DECLINED], after: programHints(e, opts) };
  const word = wordOf(o, opts);
  if (o.status === 'failed') return { ...base, mark: 'x', word, cells: [] };
  const notes = notesOf(o, opts, said);
  const joined = notes.join('; ');
  const inline = joined && joined.length <= INLINE_NOTE ? `(${joined})` : '';
  const below = inline ? [] : notes.map((n) => `    ${n}`);
  const keep = o.status === 'modified' ? [keepItLine(e, opts)] : [];
  const cells = [locationOf(e), countCell(e), fromCell(e, opts.from), inline].filter(Boolean);
  return { ...base, mark: STATUS_MARK[o.status], word, cells, after: [...below, ...keep] };
}

/** B21, D13: skipped entries of one source as one row (`⊘ skipped  source ./kit  100 entries`). */
export function skippedRow(source: string, group: InstallOutcome[], said: Set<string>): Row {
  const notes = [...new Set(group.flatMap((o) => o.notes))].filter((n) => !said.has(n));
  for (const n of notes) said.add(n);
  const cells = [`${group.length} ${group.length === 1 ? 'entry' : 'entries'}`, ...notes];
  const name = sourceLabel(source);
  return { mark: '⊘', word: statusWord('skipped'), kind: 'source', name, cells, after: [] };
}
