import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/exec/consent.js';

const lines = (n: number, f = (i: number) => `line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => f(i + 1)).join('\n')}\n`;

interface Patch {
  src: string[];
  out: string[];
  at: number;
  /** The last line written lacks a newline (a marker followed a `+` or context line). */
  noEol: boolean;
  prev: string;
}

function patchLine(p: Patch, line: string): void {
  const header = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
  const tag = line[0] ?? '';
  if (header) {
    const start = Number(header[1]) - (header[2] === '0' ? 0 : 1);
    p.out.push(...p.src.slice(p.at, start));
    p.at = start;
  } else if (tag === ' ') p.out.push(p.src[p.at++] ?? '');
  else if (tag === '-') p.at++;
  else if (tag === '+') p.out.push(line.slice(1));
  else if (tag === '\\') p.noEol ||= p.prev === '+' || p.prev === ' ';
  p.prev = tag;
}

/** Applies a unified diff to `a` (hunks in order), the way `patch` would. */
function applyDiff(a: string, diff: string): string {
  if (diff === '') return a;
  const src = a === '' ? [] : a.replace(/\n$/, '').split('\n');
  const p: Patch = { src, out: [], at: 0, noEol: false, prev: '' };
  for (const line of diff.split('\n').slice(2)) patchLine(p, line);
  const tail = src.slice(p.at);
  p.out.push(...tail);
  const eol = tail.length ? a.endsWith('\n') : !p.noEol;
  return p.out.length ? `${p.out.join('\n')}${eol ? '\n' : ''}` : '';
}

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.sh')).toBe('');
  });

  it('prints headers and one hunk with three lines of context', () => {
    const a = lines(10);
    const b = a.replace('line 5\n', 'line five\n');
    expect(unifiedDiff(a, b, 'hooks/x.sh')).toBe(
      [
        '--- a/hooks/x.sh',
        '+++ b/hooks/x.sh',
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+line five',
        ' line 6',
        ' line 7',
        ' line 8',
      ].join('\n'),
    );
  });

  it('splits distant changes into hunks and merges close ones', () => {
    const a = lines(30);
    const far = a.replace('line 2\n', 'two\n').replace('line 25\n', 'twenty-five\n');
    expect(unifiedDiff(a, far, 'f').match(/^@@/gm)).toHaveLength(2);
    const near = a.replace('line 2\n', 'two\n').replace('line 7\n', 'seven\n');
    expect(unifiedDiff(a, near, 'f').match(/^@@/gm)).toHaveLength(1);
  });

  it('shows a new file against nothing and a missing final newline', () => {
    expect(unifiedDiff('', 'echo hi\n', 'new.sh')).toBe(
      '--- a/new.sh\n+++ b/new.sh\n@@ -0,0 +1 @@\n+echo hi',
    );
    expect(unifiedDiff('echo hi\n', 'echo hi', 'x')).toBe(
      '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-echo hi\n+echo hi\n\\ No newline at end of file',
    );
  });

  it('turns a into b when applied, for any two texts', () => {
    const text = fc
      .array(fc.constantFrom('a', 'b', 'c', 'echo x', ''), { maxLength: 25 })
      .chain((ls) => fc.constantFrom(`${ls.join('\n')}\n`, ls.join('\n')))
      .map((t) => (t === '\n' ? '' : t));
    fc.assert(
      fc.property(text, text, (a, b) => {
        expect(applyDiff(a, unifiedDiff(a, b, 'f'))).toBe(b);
      }),
    );
  });
});
