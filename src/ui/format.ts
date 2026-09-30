/**
 * Pure formatting shared by the output writer and the summaries: status marks and words
 * (DESIGN.md §6), display-width padding, tables, and how lock paths read on screen.
 */
import pc from 'picocolors';
import type { OutcomeStatus } from '../core/types.js';
import { displayWidth, sliceToWidth } from '../lib/unicode.js';

export type Colors = ReturnType<typeof pc.createColors>;

export type Mark = '+' | '-' | '~' | '↺' | '=' | '⊘' | 'x' | '!' | 'i';

type Colour = Exclude<keyof Colors, 'isColorSupported'>;

export const MARK_COLOUR: Readonly<Record<Mark, Colour>> = {
  '+': 'green',
  '-': 'red',
  '~': 'cyan',
  '↺': 'cyan',
  '=': 'dim',
  '⊘': 'dim',
  x: 'red',
  '!': 'yellow',
  i: 'blue',
};

/** DESIGN.md §6 statuses: the mark each one prints with. */
export const STATUS_MARK: Readonly<Record<OutcomeStatus, Mark>> = {
  installed: '+',
  updated: '~',
  're-rendered': '~',
  restored: '↺',
  unchanged: '=',
  modified: '!',
  partial: '!',
  skipped: '⊘',
  removed: '-',
  failed: 'x',
};

const STATUS_WORD: Readonly<Record<OutcomeStatus, string>> = {
  installed: 'installed',
  updated: 'updated',
  're-rendered': 're-rendered',
  restored: 'restored',
  unchanged: 'unchanged',
  modified: 'modified (kept)',
  partial: 'partial',
  skipped: 'skipped',
  removed: 'removed',
  failed: 'failed',
};

/** What a dry run says instead of a status it did not reach. */
const WOULD: Partial<Record<OutcomeStatus, string>> = {
  installed: 'would install',
  updated: 'would update',
  're-rendered': 'would re-render',
  restored: 'would restore',
  removed: 'would remove',
};

export function statusWord(status: OutcomeStatus, dryRun = false): string {
  return (dryRun && WOULD[status]) || STATUS_WORD[status];
}

/** Pad `text` with spaces to `width` terminal columns (wide characters count 2). */
export function padVisible(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** Shorten `text` to at most `max` columns, ending with an ellipsis when cut. */
export function truncate(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (displayWidth(flat) <= max) return flat;
  return `${sliceToWidth(flat, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The widest cell of each column. */
function columnWidths(rows: string[][]): number[] {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return Array.from({ length: cols }, (_, i) =>
    rows.reduce((w, r) => Math.max(w, displayWidth(r[i] ?? '')), 0),
  );
}

function renderRow(cells: string[], widths: number[], gutter: string): string {
  return widths
    .map((w, i) => (i === widths.length - 1 ? (cells[i] ?? '') : padVisible(cells[i] ?? '', w)))
    .join(gutter)
    .trimEnd();
}

const PLAIN = pc.createColors(false);

/** Rows as padded columns with a two-space gutter; a header gets a rule under it. */
export function formatTable(rows: string[][], header?: string[], colors: Colors = PLAIN): string {
  const clean = (r: string[]) => r.map((c) => (c ?? '').replace(/\r?\n/g, ' '));
  const body = rows.map(clean);
  const widths = columnWidths(header ? [clean(header), ...body] : body);
  if (widths.length === 0) return '';
  const lines = body.map((r) => renderRow(r, widths, '  '));
  if (!header) return lines.join('\n');
  const rule = colors.dim(widths.map((w) => '─'.repeat(Math.max(w, 1))).join('  '));
  return [colors.bold(renderRow(clean(header), widths, '  ')), rule, ...lines].join('\n');
}

/** Rows as columns with a three-space gutter and no header (listings, plans). */
export function formatColumns(rows: string[][]): string[] {
  const widths = columnWidths(rows);
  return rows.map((r) => renderRow(r, widths, '   '));
}

/** `a`, `a and b`, `a, b and c`. */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** O22, R19': a ref as a table shows it: a full commit sha as its first 7 characters. */
export function shortRef(ref: string | undefined): string | undefined {
  return ref && /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

/** J10, N13: the source of an entry palm.yaml itself declares (an MCP server) reads `palm.yaml`. */
export function sourceLabel(source: string): string {
  return source === 'manifest' ? 'palm.yaml' : source;
}

/** `sha256:a7cc7911…` or a git sha → the first `n` hex characters. */
export function shortHash(hash: string | undefined, n = 7): string {
  return (hash ?? '').replace(/^sha256:/, '').slice(0, n);
}

const TOKEN_HOMES: Readonly<Record<string, string>> = {
  '<home>': '~',
  '<palm>': '~/.palm',
  '<agents>': '~/.agents',
  '<claude>': '~/.claude',
  '<codex>': '~/.codex',
  '<copilot>': '~/.copilot',
  '<cursor>': '~/.cursor',
  '<gemini>': '~/.gemini',
  '<opencode>': '~/.config/opencode',
};

/** A lock path as a person reads it: global tokens become their usual home directories. */
export function displayLockPath(lockPath: string): string {
  const token = /^<[a-z]+>/.exec(lockPath)?.[0];
  const home = token ? TOKEN_HOMES[token] : undefined;
  return home ? `${home}${lockPath.slice(token?.length ?? 0)}` : lockPath;
}

/** `512 B`, `1.1 KB`, `21 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** `palm install|remove <source> <names…>` in a hint: the source word, then the names after it. */
const HINT_COMMAND = /palm (install|remove) ((?!-)\S+)((?: (?!-)[^\s;,)]+)*)/g;

/**
 * O3, R4': a hint's command names its entity with the kind (`skill:golang`), so a name that
 * means two kinds in the source still pastes and a remove hint never loops back. The other names
 * and every option stay; `palm install mcp …` has no source word.
 */
export function withKind(hint: string, subject: { kind: string; name: string }): string {
  if (subject.kind === 'source') return publicHint(hint);
  const form = `${subject.kind}:${subject.name}`;
  return publicHint(hint).replace(
    HINT_COMMAND,
    (all, verb: string, source: string, names: string) => {
      if (source === 'mcp') return all;
      const words = names.split(' ').map((w) => (w === subject.name ? form : w));
      return `palm ${verb} ${source}${words.join(' ')}`;
    },
  );
}

/**
 * J10, R16': a server palm.yaml declares by hand has no source to name: its hints are
 * `palm install mcp <name>` and `palm remove mcp:<name>`, never the word `manifest`.
 */
export function publicHint(hint: string): string {
  return hint
    .replace(/palm install manifest ((?:mcp:)?)(\S+)/g, 'palm install mcp $2')
    .replace(/palm remove manifest (?:mcp:)?(\S+)/g, 'palm remove mcp:$1');
}
