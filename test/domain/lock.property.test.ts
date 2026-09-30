import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KINDS, type LockEntry, TARGET_IDS } from '../../src/core/types.js';
import { fragmentKey, Lock } from '../../src/domain/lock.js';

const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,10}$/);
const hash = fc.stringMatching(/^[0-9a-f]{8}$/).map((h) => `sha256:${h}`);
const path = fc.array(name, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));

const entryArb: fc.Arbitrary<LockEntry> = fc.record({
  kind: fc.constantFrom(...KINDS),
  name,
  source: fc.constantFrom('a/b', './kit', 'acme'),
  path,
  content: hash,
  render: fc.dictionary(fc.constantFrom(...TARGET_IDS), hash),
  files: fc.array(path, { maxLength: 4 }),
  trust: fc.option(fc.array(hash, { maxLength: 3 }), { nil: undefined }),
  notes: fc.option(fc.array(fc.string({ maxLength: 20 }), { maxLength: 2 }), { nil: undefined }),
});

function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (seed * (i + 7)) % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('Lock determinism (property)', () => {
  it('the same entries in any order give the same bytes', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), fc.nat(), (entries, seed) => {
        const a = new Lock({}, entries);
        const b = new Lock({}, shuffled(a.entries, seed));
        expect(b.hash()).toBe(a.hash());
        expect(JSON.stringify(b.toJSON())).toBe(JSON.stringify(a.toJSON()));
      }),
    );
  });

  it('entries come out sorted by kind, then name in any case', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), (entries) => {
        const out = new Lock({}, entries).toJSON().entries;
        for (let i = 1; i < out.length; i++) {
          const [p, c] = [out[i - 1] as LockEntry, out[i] as LockEntry];
          const byKind = KINDS.indexOf(p.kind) - KINDS.indexOf(c.kind);
          expect(byKind < 0 || (byKind === 0 && p.name.toLowerCase() <= c.name.toLowerCase())).toBe(
            true,
          );
        }
      }),
    );
  });
});

describe('fragmentKey (property)', () => {
  it('is stable when the identity fields are reordered and other fields change', () => {
    const cmd = fc.string({ minLength: 1, maxLength: 20 });
    fc.assert(
      fc.property(
        fc.string({ maxLength: 10 }),
        fc.array(cmd, { minLength: 1, maxLength: 3 }),
        fc.nat(),
        (matcher, commands, t) => {
          const a = { matcher, hooks: commands.map((command) => ({ type: 'command', command })) };
          const b = {
            hooks: [...commands]
              .reverse()
              .map((command) => ({ timeout: t, command, type: 'command' })),
            matcher,
          };
          expect(fragmentKey('/hooks/Stop', b)).toBe(fragmentKey('/hooks/Stop', a));
        },
      ),
    );
  });
});
