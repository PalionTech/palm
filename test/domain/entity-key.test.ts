import { describe, expect, it } from 'vitest';
import { EntityKey, entityId, LockKey, lockId, Via } from '../../src/domain/entity-key.js';

describe('EntityKey', () => {
  it('identifies kind + name, names case-insensitively', () => {
    const k = EntityKey.of({ kind: 'skill', name: 'TDD' });
    expect(k.id).toBe('skill:tdd');
    expect(k.toString()).toBe('skill:TDD');
    expect(k.is({ kind: 'skill', name: 'tdd' })).toBe(true);
    expect(k.is({ kind: 'agent', name: 'tdd' })).toBe(false);
    expect(entityId({ kind: 'hook', name: 'Fmt' })).toBe('hook:fmt');
  });
});

describe('LockKey', () => {
  it('adds the source name, compared exactly', () => {
    const k = LockKey.of({ kind: 'skill', name: 'TDD', source: 'mattpocock/skills' });
    expect(k.id).toBe('skill:tdd@mattpocock/skills');
    expect(k.toString()).toBe('skill:TDD@mattpocock/skills');
    expect(k.entity.id).toBe('skill:tdd');
    expect(k.is({ kind: 'skill', name: 'tdd', source: 'mattpocock/skills' })).toBe(true);
    expect(k.is({ kind: 'skill', name: 'tdd', source: 'other' })).toBe(false);
    expect(lockId({ kind: 'mcp', name: 'Docs', source: 'manifest' })).toBe('mcp:docs@manifest');
  });
});

describe('Via', () => {
  it('round-trips plugin:<name>', () => {
    const v = Via.parse('plugin:superpowers');
    expect(v.name).toBe('superpowers');
    expect(v.toString()).toBe('plugin:superpowers');
    expect(v.key.id).toBe('plugin:superpowers');
    expect(Via.of({ kind: 'plugin', name: 'kit' }).toString()).toBe('plugin:kit');
  });

  it('compares with a stored via case-insensitively', () => {
    const v = Via.of({ kind: 'plugin', name: 'Kit' });
    expect(v.is('plugin:kit')).toBe(true);
    expect(v.is('plugin:other')).toBe(false);
    expect(v.is(undefined)).toBe(false);
  });

  it('accepts plugins only: agent:<name> and malformed values are E_PARSE; tryParse gives undefined', () => {
    for (const bad of ['agent:reviewer', 'plugin:', 'kit', ''])
      expect(() => Via.parse(bad), bad).toThrowError(expect.objectContaining({ code: 'E_PARSE' }));
    expect(Via.tryParse('agent:x')).toBeUndefined();
    expect(Via.tryParse(undefined)).toBeUndefined();
  });
});
