import { describe, expect, it } from 'vitest';
import {
  parseJson,
  stringifyJson,
  stripJsonComments,
  stripTrailingCommas,
} from '../../src/lib/json.js';
import { normalizeText, stripBom } from '../../src/lib/text.js';

describe('text', () => {
  it('strips one leading BOM only', () => {
    expect(stripBom('\uFEFFa')).toBe('a');
    expect(stripBom('a\uFEFF')).toBe('a\uFEFF');
    expect(stripBom('')).toBe('');
  });

  it('normalizes CRLF and lone CR to LF and drops the BOM', () => {
    expect(normalizeText('\uFEFFa\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeText('a\nb')).toBe('a\nb');
  });
});

describe('stripJsonComments', () => {
  it('blanks line and block comments but keeps line breaks and positions', () => {
    const text = '{\n  // note\n  "a": 1, /* x\n y */ "b": 2\n}';
    const out = stripJsonComments(text);
    expect(out).toHaveLength(text.length);
    expect(out.split('\n')).toHaveLength(text.split('\n').length);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it('leaves comment markers inside strings alone', () => {
    const text = '{"url": "https://x.dev/a", "glob": "src/**/*.ts", "q": "say \\"//hi\\""}';
    expect(stripJsonComments(text)).toBe(text);
  });

  it('handles an unterminated block comment and an unterminated string', () => {
    expect(stripJsonComments('1 /* open')).toBe('1        ');
    expect(stripJsonComments('"open // x')).toBe('"open // x');
  });
});

describe('stripTrailingCommas', () => {
  it('blanks commas before } and ] outside strings', () => {
    expect(stripTrailingCommas('{"a": [1, 2,\n], "b": ",}",\n}')).toBe(
      '{"a": [1, 2 \n], "b": ",}" \n}',
    );
  });
});

describe('parseJson', () => {
  it('parses strict JSON and ignores a BOM', () => {
    expect(parseJson('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });

  it('rejects JSONC unless tolerant', () => {
    const jsonc = '{\n  // c\n  "a": "http://x", /* b */\n  "b": [1,],\n}';
    expect(() => parseJson(jsonc)).toThrow(SyntaxError);
    expect(parseJson(jsonc, { tolerant: true })).toEqual({ a: 'http://x', b: [1] });
  });

  it('throws the SyntaxError of the tolerant retry', () => {
    expect(() => parseJson('{"a": }', { tolerant: true })).toThrow(SyntaxError);
  });
});

describe('stringifyJson', () => {
  it('uses a 2-space indent and a trailing newline', () => {
    expect(stringifyJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});
