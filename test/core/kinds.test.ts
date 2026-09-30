import { describe, expect, it } from 'vitest';
import {
  isCommandWord,
  manifestKey,
  parseKind,
  parseResource,
  pluralize,
  RESOURCES,
  resourceWords,
  SHORT_NAMES,
} from '../../src/core/kinds.js';
import { KINDS } from '../../src/core/types.js';

describe('kinds', () => {
  it('parses singular, plural and short kind words in any case', () => {
    expect(parseKind('Skills')).toBe('skill');
    expect(parseKind('ag')).toBe('agent');
    expect(parseKind('rules')).toBe('instruction');
    expect(parseKind('hk')).toBe('hook');
    expect(parseKind('pl')).toBe('plugin');
    expect(parseKind('origin')).toBeUndefined();
    expect(parseKind(undefined)).toBeUndefined();
  });

  it('maps command words to skill and says so through isCommandWord', () => {
    for (const w of ['command', 'Commands', 'cmd', 'prompt', 'prompts']) {
      expect(parseKind(w)).toBe('skill');
      expect(isCommandWord(w)).toBe(true);
    }
    expect(isCommandWord('skill')).toBe(false);
  });

  it('parses resources: source words (origin for one release), target words and all', () => {
    for (const w of ['source', 'sources', 'src', 'origin', 'origins', 'orig'])
      expect(parseResource(w)).toBe('source');
    expect(parseResource('tg')).toBe('target');
    expect(parseResource('all')).toBe('all');
    expect(parseResource('mcp')).toBe('mcp');
    expect(parseResource('widgets')).toBeUndefined();
    expect(RESOURCES).toEqual([...KINDS, 'source', 'target', 'all']);
    expect(SHORT_NAMES.source).toBe('src');
    expect(resourceWords('source')).toEqual([
      'source',
      'sources',
      'src',
      'origin',
      'origins',
      'orig',
    ]);
  });

  it('names manifest lists and plurals', () => {
    expect(KINDS.map(manifestKey)).toEqual([
      'skills',
      'agents',
      'instructions',
      'hooks',
      'mcp',
      'plugins',
    ]);
    expect(pluralize('skill', 1)).toBe('skill');
    expect(pluralize('skill', 2)).toBe('skills');
    expect(pluralize('mcp', 3)).toBe('MCP servers');
  });
});
