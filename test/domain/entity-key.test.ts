import { describe, expect, it } from 'vitest';
import {
  EntityKey,
  entityId,
  isViaKind,
  LockKey,
  lockId,
  Via,
} from '../../src/domain/entity-key.js';

describe('EntityKey', () => {
  it('identifies kind + name, names case-insensitively', () => {
    const k = EntityKey.of({ kind: 'skill', name: 'TDD' });
    expect(k.kind).toBe('skill');
    expect(k.name).toBe('TDD');
    expect(k.id).toBe('skill:tdd');
    expect(k.id).toBe(entityId({ kind: 'skill', name: 'tdd' }));
    expect(k.is({ kind: 'skill', name: 'tdd' })).toBe(true);
    expect(k.is({ kind: 'agent', name: 'tdd' })).toBe(false);
    expect(k.is({ kind: 'skill', name: 'tdd2' })).toBe(false);
    expect(k.toString()).toBe('skill:TDD');
  });
});

describe('LockKey', () => {
  it('adds the origin, compared exactly', () => {
    const k = LockKey.of({ kind: 'mcp', name: 'Docs', origin: 'a' });
    expect(k.id).toBe('mcp:docs@a');
    expect(k.id).toBe(lockId({ kind: 'mcp', name: 'docs', origin: 'a' }));
    expect(k.entity.id).toBe('mcp:docs');
    expect(k.is({ kind: 'mcp', name: 'DOCS', origin: 'a' })).toBe(true);
    expect(k.is({ kind: 'mcp', name: 'docs', origin: 'A' })).toBe(false);
    expect(k.is({ kind: 'skill', name: 'docs', origin: 'a' })).toBe(false);
    expect(k.toString()).toBe('mcp:Docs@a');
  });
});

describe('Via', () => {
  it('round-trips plugin:<name> and agent:<name>', () => {
    for (const text of ['plugin:superpowers', 'agent:reviewer', 'agent:ns:with:colons']) {
      expect(Via.parse(text).toString()).toBe(text);
    }
    const v = Via.parse('agent:ns:x');
    expect([v.kind, v.name]).toEqual(['agent', 'ns:x']);
    expect(v.key.id).toBe('agent:ns:x');
    expect(v.key.is({ kind: 'agent', name: 'NS:X' })).toBe(true);
  });

  it('is built from a plugin or agent entry', () => {
    expect(Via.of({ kind: 'plugin', name: 'P' }).toString()).toBe('plugin:P');
    expect(
      Via.parse(Via.of({ kind: 'agent', name: 'a' }).toString()).key.is({
        kind: 'agent',
        name: 'A',
      }),
    ).toBe(true);
    expect(() => Via.of({ kind: 'skill', name: 's' })).toThrow(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    );
  });

  it('compares with a stored via case-insensitively', () => {
    const v = Via.parse('plugin:Superpowers');
    expect(v.is('plugin:superpowers')).toBe(true);
    expect(v.is('agent:superpowers')).toBe(false);
    expect(v.is('plugin:other')).toBe(false);
    expect(v.is(undefined)).toBe(false);
    expect(v.is('garbage')).toBe(false);
  });

  it('rejects malformed values; tryParse returns undefined instead', () => {
    for (const bad of ['', 'plugin', 'plugin:', 'skill:x', ':x']) {
      expect(() => Via.parse(bad)).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
      expect(Via.tryParse(bad)).toBeUndefined();
    }
    expect(Via.tryParse(undefined)).toBeUndefined();
    expect(Via.tryParse('plugin:x')?.toString()).toBe('plugin:x');
  });

  it('isViaKind holds for plugins and agents only', () => {
    expect(['plugin', 'agent', 'skill', 'mcp'].map((k) => isViaKind(k as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
