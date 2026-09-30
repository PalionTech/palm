/**
 * The rows of an install summary (src/ui/summary.ts): one per entry that changed, programs left
 * out with the commands that show and install them, skipped entries of one source as one row,
 * and every note once.
 */
import type { InstallOutcome, LockEntry, LockSource, Scope } from '../core/types.js';
import { plural } from '../lib/text.js';
import { displayLockPath, type Mark, STATUS_MARK, shortHash, statusWord } from './format.js';

export interface RowOptions {
  scope: Scope;
  dryRun?: boolean;
  /** Lock sources, for a `from <source> <version>` cell (installs that named their entities). */
  from?: Record<string, LockSource>;
  /** The source as a pasteable command names it (K9): the key once declared, else as typed. */
  sourceWord?: (source: string) => string;
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
  const version = s.resolved ?? s.ref ?? (s.tree ? `tree ${shortHash(s.tree)}` : '');
  return `from ${e.source}${version ? ` ${version}` : ''}`;
}

/** Notes that fit in the row's last cell: `(cursor reads .agents/skills)`. */
const INLINE_NOTE = 60;

/** The row's notes not printed on an earlier row; per-target words say `would …` in a dry run. */
function notesOf(o: InstallOutcome, opts: RowOptions, said: Set<string>): string[] {
  const perTarget = Object.entries(o.perTarget ?? {}).map(
    ([t, s]) => `${t}: ${statusWord(s, opts.dryRun)}`,
  );
  const fresh = [...new Set([...perTarget, ...o.notes])].filter((n) => !said.has(n));
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
  if (e.source === 'manifest')
    return [
      `    see it:      palm install --dry-run --review${g}`,
      `    install it:  palm install${g}`,
    ];
  const source = opts.sourceWord?.(e.source) ?? e.source;
  const cmd = `palm install ${source} ${e.kind}:${e.name}`;
  return [`    see it:      ${cmd} --dry-run${g}`, `    install it:  ${cmd}${g}`];
}

/** L10: after --force, the way to keep an edit. */
function keepItLine(e: LockEntry, scope: Scope): string {
  const g = scope === 'global' ? ' -g' : '';
  return `    to keep your change, move it into your own source: palm create ${e.kind} ${e.name}${g}`;
}

export function outcomeRow(o: InstallOutcome, opts: RowOptions, said: Set<string>): Row {
  const e = o.entry;
  const base = { kind: e.kind, name: e.name, after: [] as string[] };
  if (programLeftOut(o))
    return { ...base, mark: '!', word: LEFT_OUT, cells: [DECLINED], after: programHints(e, opts) };
  const word = statusWord(o.status, opts.dryRun);
  if (o.status === 'failed') return { ...base, mark: 'x', word, cells: [] };
  const notes = notesOf(o, opts, said);
  const joined = notes.join('; ');
  const inline = joined && joined.length <= INLINE_NOTE ? `(${joined})` : '';
  const below = inline ? [] : notes.map((n) => `    ${n}`);
  const keep = o.status === 'modified' ? [keepItLine(e, opts.scope)] : [];
  const cells = [locationOf(e), countCell(e), fromCell(e, opts.from), inline].filter(Boolean);
  return { ...base, mark: STATUS_MARK[o.status], word, cells, after: [...below, ...keep] };
}

/** B21, D13: skipped entries of one source as one row (`⊘ skipped  source ./kit  100 entries`). */
export function skippedRow(source: string, group: InstallOutcome[], said: Set<string>): Row {
  const notes = [...new Set(group.flatMap((o) => o.notes))].filter((n) => !said.has(n));
  for (const n of notes) said.add(n);
  const cells = [`${group.length} ${group.length === 1 ? 'entry' : 'entries'}`, ...notes];
  return { mark: '⊘', word: statusWord('skipped'), kind: 'source', name: source, cells, after: [] };
}
