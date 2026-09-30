import { describe, expect, it } from 'vitest';
import {
  envRef,
  findPlaceholders,
  isFillInValue,
  isRuntimeVar,
  PLACEHOLDER_RE,
  parsePlaceholder,
  RUNTIME_VARS,
  replacePlaceholders,
} from '../../src/lib/placeholders.js';

describe('findPlaceholders', () => {
  it('finds every style with names, defaults and raw text', () => {
    const text = 'a ${TOKEN} b ${env:API_KEY} c ${PORT:-8080} d ${env:X:-} e ${OPT:-}';
    expect(findPlaceholders(text)).toEqual([
      { name: 'TOKEN', style: 'dollar', raw: '${TOKEN}' },
      { name: 'API_KEY', style: 'env-colon', raw: '${env:API_KEY}' },
      { name: 'PORT', style: 'dollar-default', default: '8080', raw: '${PORT:-8080}' },
      { name: 'X', style: 'env-colon', default: '', raw: '${env:X:-}' },
      { name: 'OPT', style: 'dollar-default', default: '', raw: '${OPT:-}' },
    ]);
  });

  it('ignores things that are not placeholders', () => {
    expect(findPlaceholders('$TOKEN ${1BAD} ${} ${a-b} ${X:default} {Y}')).toEqual([]);
  });

  it('exposes the regex with name and default groups', () => {
    const m = [...'${A:-b}'.matchAll(PLACEHOLDER_RE)][0]!;
    expect([m[1], m[2]]).toEqual(['A', 'b']);
  });
});

describe('parsePlaceholder', () => {
  it('accepts exactly one token', () => {
    expect(parsePlaceholder('${env:KEY}')).toEqual({
      name: 'KEY',
      style: 'env-colon',
      raw: '${env:KEY}',
    });
    expect(parsePlaceholder('Bearer ${KEY}')).toBeUndefined();
    expect(parsePlaceholder('${A}${B}')).toBeUndefined();
    expect(parsePlaceholder('plain')).toBeUndefined();
  });
});

describe('replacePlaceholders', () => {
  it('replaces tokens and keeps those the callback declines', () => {
    const out = replacePlaceholders('${HOME}/x ${KEY:-d} ${env:T}', (p) =>
      isRuntimeVar(p.name) ? undefined : `<${p.name}|${p.style}|${p.default ?? ''}>`,
    );
    expect(out).toBe('${HOME}/x <KEY|dollar-default|d> <T|env-colon|>');
  });

  it('inserts replacement text literally ($ patterns are not expanded)', () => {
    expect(replacePlaceholders('${A}', () => '$&$1')).toBe('$&$1');
  });
});

describe('envRef', () => {
  it('renders each style', () => {
    expect(envRef('KEY')).toBe('${KEY}');
    expect(envRef('KEY', 'dollar')).toBe('${KEY}');
    expect(envRef('KEY', 'env-colon')).toBe('${env:KEY}');
    expect(envRef('KEY', 'dollar-default')).toBe('${KEY:-}');
    expect(envRef('KEY', 'dollar-default', 'x')).toBe('${KEY:-x}');
  });

  it('round-trips through findPlaceholders', () => {
    for (const style of ['dollar', 'env-colon', 'dollar-default'] as const) {
      expect(findPlaceholders(envRef('NAME', style, 'v'))[0]).toMatchObject({
        name: 'NAME',
        style,
      });
    }
  });
});

describe('runtime variables and fill-in values', () => {
  it('knows the harness and OS runtime variables', () => {
    for (const v of [
      'CLAUDE_PLUGIN_ROOT',
      'CURSOR_PLUGIN_ROOT',
      'PLUGIN_ROOT',
      'CLAUDE_PROJECT_DIR',
      'workspaceFolder',
      'workspaceRoot',
      'pathSeparator',
      'TMPDIR',
      'HOME',
      'PWD',
      'USER',
    ]) {
      expect(isRuntimeVar(v)).toBe(true);
    }
    expect(isRuntimeVar('GITHUB_TOKEN')).toBe(false);
    expect(isRuntimeVar('home')).toBe(false);
    for (const v of ['CURSOR_PROJECT_DIR', 'GEMINI_PROJECT_DIR', 'extensionPath'])
      expect(isRuntimeVar(v)).toBe(true);
    expect(RUNTIME_VARS.size).toBe(18);
  });

  it.each([
    ['', true],
    ['<your key>', true],
    ['your-token-here', true],
    ['YOUR_API_KEY', true],
    ['sk-live-123', false],
    ['yourself', false],
  ])('isFillInValue(%j) = %s', (v, ok) => {
    expect(isFillInValue(v)).toBe(ok);
  });
});
