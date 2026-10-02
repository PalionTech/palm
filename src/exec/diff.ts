/**
 * A unified diff of two texts, for `d` at the consent prompt and `update --review`. Common
 * prefix and suffix lines are trimmed first; the rest is an LCS diff, or a whole replacement
 * when it would be too large to compute.
 */

const CONTEXT = 3;
/** LCS table cells above which the changed middle is shown as removed and re-added. */
const MAX_CELLS = 4_000_000;
const NO_EOL = '\\ No newline at end of file';

interface Line {
  text: string;
  /** False for a last line without a trailing newline. */
  eol: boolean;
}

type Tag = ' ' | '-' | '+';

interface Op {
  tag: Tag;
  line: Line;
}

function toLines(text: string): Line[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const eol = parts.at(-1) === '';
  if (eol) parts.pop();
  return parts.map((t, i) => ({ text: t, eol: eol || i < parts.length - 1 }));
}

function same(a: Line | undefined, b: Line | undefined): boolean {
  return a !== undefined && b !== undefined && a.text === b.text && a.eol === b.eol;
}

/** LCS lengths of every suffix pair: `table[i * (m + 1) + j]` = LCS(a[i..], b[j..]). */
function lcsTable(a: Line[], b: Line[]): Uint32Array {
  const m = b.length;
  const table = new Uint32Array((a.length + 1) * (m + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const at = i * (m + 1) + j;
      table[at] = same(a[i], b[j])
        ? (table[at + m + 2] ?? 0) + 1
        : Math.max(table[at + m + 1] ?? 0, table[at + 1] ?? 0);
    }
  }
  return table;
}

function middleOps(a: Line[], b: Line[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line): Op => ({ tag: '-', line })),
      ...b.map((line): Op => ({ tag: '+', line })),
    ];
  }
  const table = lcsTable(a, b);
  const w = b.length + 1;
  /** Dropping a[i] keeps at least as long a common subsequence as skipping b[j]. */
  const dropA = (i: number, j: number) =>
    (table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y && same(x, y)) {
      out.push({ tag: ' ', line: x });
      i++;
      j++;
    } else if (x && (!y || dropA(i, j))) {
      out.push({ tag: '-', line: x });
      i++;
    } else if (y) {
      out.push({ tag: '+', line: y });
      j++;
    }
  }
  return out;
}

function editScript(a: Line[], b: Line[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && same(a[head], b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail], b[b.length - 1 - tail])
  )
    tail++;
  const keep = (line: Line): Op => ({ tag: ' ', line });
  return [
    ...a.slice(0, head).map(keep),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(keep),
  ];
}

/** `[start, end)` op ranges around the changes, CONTEXT lines each side, overlapping ones merged. */
function hunkRanges(ops: Op[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  ops.forEach((op, i) => {
    if (op.tag === ' ') return;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(ops.length, i + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  });
  return ranges;
}

/** `-3,4` / `-3` (one line) / `-2,0` (empty: the line before). */
function range(sign: '-' | '+', before: number, count: number): string {
  if (count === 0) return `${sign}${before},0`;
  return count === 1 ? `${sign}${before + 1}` : `${sign}${before + 1},${count}`;
}

function counts(ops: Op[]): { a: number; b: number } {
  return {
    a: ops.filter((o) => o.tag !== '+').length,
    b: ops.filter((o) => o.tag !== '-').length,
  };
}

function hunkText(ops: Op[], [start, end]: [number, number]): string[] {
  const before = counts(ops.slice(0, start));
  const inside = counts(ops.slice(start, end));
  const header = `@@ ${range('-', before.a, inside.a)} ${range('+', before.b, inside.b)} @@`;
  const body = ops
    .slice(start, end)
    .flatMap((o) => [`${o.tag}${o.line.text}`, ...(o.line.eol ? [] : [NO_EOL])]);
  return [header, ...body];
}

/**
 * The unified diff from `a` to `b` (`--- a/<name>`, `+++ b/<name>`, hunks with three lines of
 * context), or `''` when they are equal.
 */
export function unifiedDiff(a: string, b: string, name: string): string {
  if (a === b) return '';
  const ops = editScript(toLines(a), toLines(b));
  const hunks = hunkRanges(ops).flatMap((r) => hunkText(ops, r));
  return [`--- a/${name}`, `+++ b/${name}`, ...hunks].join('\n');
}
