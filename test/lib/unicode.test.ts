import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  codePointName,
  describeCodePoint,
  displayWidth,
  hasHiddenUnicode,
  hiddenUnicodeSeverity,
  MAY_HIDE_UNICODE,
  scanHiddenUnicode,
  sliceToWidth,
  stripHiddenUnicode,
} from '../../src/lib/unicode.js';

const ch = (cp: number): string => String.fromCodePoint(cp);

describe('scanHiddenUnicode', () => {
  it.each<[string, number]>([
    ['LEFT-TO-RIGHT EMBEDDING', 0x202a],
    ['RIGHT-TO-LEFT EMBEDDING', 0x202b],
    ['POP DIRECTIONAL FORMATTING', 0x202c],
    ['LEFT-TO-RIGHT OVERRIDE', 0x202d],
    ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['LEFT-TO-RIGHT ISOLATE', 0x2066],
    ['RIGHT-TO-LEFT ISOLATE', 0x2067],
    ['FIRST STRONG ISOLATE', 0x2068],
    ['POP DIRECTIONAL ISOLATE', 0x2069],
    ['LANGUAGE TAG', 0xe0001],
    ['TAG LATIN SMALL LETTER A', 0xe0061],
    ['TAG LATIN CAPITAL LETTER Z', 0xe005a],
    ['TAG DIGIT 7', 0xe0037],
    ['CANCEL TAG', 0xe007f],
    ['VARIATION SELECTOR-17', 0xe0100],
    ['VARIATION SELECTOR-256', 0xe01ef],
  ])('%s (U+%s) is critical', (name, cp) => {
    expect(scanHiddenUnicode(`ab${ch(cp)}cd`)).toEqual([
      { severity: 'critical', codePoint: cp, index: 2, name },
    ]);
  });

  it.each<[string, number]>([
    ['ZERO WIDTH SPACE', 0x200b],
    ['ZERO WIDTH NON-JOINER', 0x200c],
    ['ZERO WIDTH JOINER', 0x200d],
    ['LEFT-TO-RIGHT MARK', 0x200e],
    ['RIGHT-TO-LEFT MARK', 0x200f],
    ['WORD JOINER', 0x2060],
    ['INVISIBLE TIMES', 0x2062],
    ['ZERO WIDTH NO-BREAK SPACE', 0xfeff],
    ['SOFT HYPHEN', 0x00ad],
    ['ARABIC LETTER MARK', 0x061c],
    ['MONGOLIAN VOWEL SEPARATOR', 0x180e],
    ['INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
    ['HANGUL FILLER', 0x3164],
    ['COMBINING GRAPHEME JOINER', 0x034f],
  ])('%s (U+%s) is a warning', (name, cp) => {
    expect(scanHiddenUnicode(`ab${ch(cp)}cd`)).toEqual([
      { severity: 'warning', codePoint: cp, index: 2, name },
    ]);
  });

  it('reports UTF-16 offsets, astral characters counting two units', () => {
    const text = `😀${ch(0xe0041)}x${ch(0x202e)}`;
    expect(scanHiddenUnicode(text).map((f) => [f.index, f.codePoint])).toEqual([
      [2, 0xe0041],
      [5, 0x202e],
    ]);
    const [, second] = scanHiddenUnicode(text);
    expect(text.codePointAt(second!.index)).toBe(0x202e);
  });

  it('allows a BOM at offset 0 only', () => {
    expect(scanHiddenUnicode('﻿hello')).toEqual([]);
    expect(scanHiddenUnicode('he﻿llo')).toEqual([
      { severity: 'warning', codePoint: 0xfeff, index: 2, name: 'ZERO WIDTH NO-BREAK SPACE' },
    ]);
    expect(scanHiddenUnicode('﻿﻿').map((f) => f.index)).toEqual([1]);
  });

  it('leaves ordinary text, emoji and visible format marks alone', () => {
    expect(scanHiddenUnicode('plain ASCII\n\ttabs and newlines\r\n')).toEqual([]);
    expect(scanHiddenUnicode('Grüße, 日本語, עברית, العربية')).toEqual([]);
    // emoji presentation selector (VS16) and skin tones are not hidden
    expect(scanHiddenUnicode('❤️ 👍🏽')).toEqual([]);
    // ZWJ inside an emoji sequence spells the emoji
    expect(scanHiddenUnicode('👨‍👩‍👧 👩🏽‍💻')).toEqual([]);
    // Arabic number sign renders a glyph
    expect(scanHiddenUnicode('؀123')).toEqual([]);
  });

  it('still reports a ZWJ that joins no emoji', () => {
    expect(scanHiddenUnicode('a‍b').map((f) => f.codePoint)).toEqual([0x200d]);
    expect(scanHiddenUnicode('👍‍').map((f) => f.codePoint)).toEqual([0x200d]);
  });

  it('finds ASCII smuggled as tag characters', () => {
    const hidden = [...'ignore'].map((c) => ch(0xe0000 + c.charCodeAt(0))).join('');
    const findings = scanHiddenUnicode(`Be helpful.${hidden}`);
    expect(findings).toHaveLength(6);
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
    expect(findings[0]).toMatchObject({ index: 11, name: 'TAG LATIN SMALL LETTER I' });
  });
});

describe('stripHiddenUnicode', () => {
  it('removes every finding and keeps everything else', () => {
    const text = `﻿a${ch(0x202e)}b​c${ch(0xe0041)}d 👨‍👩‍👧 é`;
    expect(stripHiddenUnicode(text)).toBe('﻿abcd 👨‍👩‍👧 é');
  });

  it('with severity critical, keeps warnings', () => {
    const text = `a${ch(0x202e)}b​c`;
    expect(stripHiddenUnicode(text, { severity: 'critical' })).toBe('ab​c');
    expect(stripHiddenUnicode(text, { severity: 'warning' })).toBe('abc');
  });

  it('returns clean text unchanged', () => {
    const text = 'nothing hidden here\n';
    expect(stripHiddenUnicode(text)).toBe(text);
  });

  it('property: the result has no findings and keeps every visible character in order', () => {
    const hidden = fc.constantFrom(
      0x202e,
      0x2066,
      0xe0041,
      0xe0100,
      0x200b,
      0x2060,
      0xfeff,
      0x00ad,
    );
    const piece = fc.oneof(
      fc.string({ unit: 'grapheme-ascii' }),
      hidden.map((cp) => String.fromCodePoint(cp)),
    );
    fc.assert(
      fc.property(fc.array(piece), (parts) => {
        const text = parts.join('');
        const out = stripHiddenUnicode(text);
        expect(scanHiddenUnicode(out)).toEqual([]);
        const visible = (s: string) => s.replace(/[^\x20-\x7e]/g, '');
        expect(visible(out)).toBe(visible(text));
      }),
    );
  });
});

describe('describeCodePoint / codePointName / hasHiddenUnicode', () => {
  it('names code points', () => {
    expect(describeCodePoint(0x202e)).toBe('U+202E RIGHT-TO-LEFT OVERRIDE');
    expect(describeCodePoint(0xe0020)).toBe('U+E0020 TAG SPACE');
    expect(describeCodePoint(0xad)).toBe('U+00AD SOFT HYPHEN');
    expect(codePointName(0xe0021)).toBe('TAG "!"');
    expect(codePointName(0x1d173)).toBe('FORMAT CHARACTER');
  });

  it('hasHiddenUnicode honours the severity floor', () => {
    expect(hasHiddenUnicode('a​b')).toBe(true);
    expect(hasHiddenUnicode('a​b', 'critical')).toBe(false);
    expect(hasHiddenUnicode(`a${ch(0x202e)}b`, 'critical')).toBe(true);
    expect(hasHiddenUnicode('﻿clean')).toBe(false);
  });
});

describe('MAY_HIDE_UNICODE (the pre-check inside scanHiddenUnicode)', () => {
  it('matches every code point the full per-character rule reports', () => {
    const missed: string[] = [];
    const planes: Array<[number, number]> = [
      [0x0, 0x1ffff],
      [0xe0000, 0xeffff],
    ];
    for (const [from, to] of planes) {
      for (let cp = from; cp <= to; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        if (hiddenUnicodeSeverity(cp) && !MAY_HIDE_UNICODE.test(`a${ch(cp)}b`))
          missed.push(cp.toString(16));
      }
    }
    expect(missed).toEqual([]);
  });
});

describe('displayWidth / sliceToWidth', () => {
  it('counts terminal columns: wide CJK and emoji 2, marks and joiners 0, ANSI 0', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('ｱ')).toBe(1); // halfwidth katakana
    expect(displayWidth('Ａ')).toBe(2); // fullwidth A
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('👨‍👩‍👧')).toBe(2); // ZWJ sequence
    expect(displayWidth('👍🏽')).toBe(2); // skin tone modifier
    expect(displayWidth('☺')).toBe(1); // text presentation
    expect(displayWidth('☺️')).toBe(2); // emoji presentation selector
    expect(displayWidth('é')).toBe(1); // combining acute
    expect(displayWidth('a​b')).toBe(2); // zero width space
    expect(displayWidth('\u001b[31m日本\u001b[39m')).toBe(4);
  });

  it('slices between grapheme clusters without exceeding the width', () => {
    expect(sliceToWidth('日本語', 5)).toBe('日本');
    expect(sliceToWidth('abc', 2)).toBe('ab');
    expect(sliceToWidth('👨‍👩‍👧x', 1)).toBe('');
    expect(sliceToWidth('👨‍👩‍👧x', 3)).toBe('👨‍👩‍👧x');
    expect(sliceToWidth('éx', 1)).toBe('é');
  });
});
