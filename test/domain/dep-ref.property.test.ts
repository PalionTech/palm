import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DepRef as DepRefData } from '../../src/core/types.js';
import { DepRef } from '../../src/domain/dep-ref.js';

const lower = 'abcdefghijklmnopqrstuvwxyz0123456789';
const slugChar = fc.constantFrom(...`${lower}-_.`);
const slug = fc
  .tuple(fc.constantFrom(...lower), fc.string({ unit: slugChar, maxLength: 20 }))
  .map(([first, rest]) => first + rest);

/** Registry names (`io.github.acme/weather`): dotted namespace, `/`, slug. */
const registryName = fc
  .tuple(fc.array(slug, { minLength: 1, maxLength: 3 }), slug)
  .map(([ns, n]) => `${ns.join('.')}/${n}`);
/** Scoped names (`@scope/pkg`): an `@` that is not an origin separator. */
const scopedName = fc.tuple(slug, slug).map(([scope, n]) => `@${scope}/${n}`);
/** Registry names whose last segment carries an `@`, e.g. `io.x/y@z/w`: `/` follows the `@`. */
const atInRegistry = fc
  .tuple(registryName, slug, slug)
  .map(([base, at, rest]) => `${base}@${at}/${rest}`);

/** Entity names: plain slugs, registry names and `@scope/pkg`. */
const name = fc.oneof(slug, registryName, scopedName, atInRegistry);
/** Origin aliases never contain `/`, `@` or `#`. */
const origin = slug;
/** Git refs: tags, branches with slashes, shas. */
const ref = fc
  .tuple(slug, fc.array(slug, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail].join('/'));

const depRef: fc.Arbitrary<DepRefData> = fc
  .record({
    name,
    origin: fc.option(origin, { nil: undefined }),
    ref: fc.option(ref, { nil: undefined }),
  })
  .map(({ name, origin, ref }) => ({
    name,
    ...(origin ? { origin } : {}),
    ...(ref ? { ref } : {}),
  }));

describe('DepRef grammar (property)', () => {
  it('parses every formatted <name>[@<origin>][#<ref>] back to the same parts and string', () => {
    fc.assert(
      fc.property(depRef, (dep) => {
        const s = DepRef.from(dep).toString();
        const parsed = DepRef.parse(s);
        expect(parsed.toJSON()).toEqual(dep);
        expect(parsed.toString()).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on formatted input, with surrounding whitespace too', () => {
    fc.assert(
      fc.property(depRef, fc.constantFrom('', ' ', '\t', '  '), (dep, pad) => {
        const s = `${pad}${DepRef.from(dep).toString()}${pad}`;
        expect(() => DepRef.parse(s)).not.toThrow();
        expect(DepRef.parse(s).name).toBe(dep.name);
      }),
      { numRuns: 300 },
    );
  });

  it('keeps an `@` followed by `/` in the name (registry and scoped names)', () => {
    fc.assert(
      fc.property(fc.oneof(registryName, scopedName, atInRegistry), (n) => {
        const parsed = DepRef.parse(n);
        expect(parsed.name).toBe(n);
        expect(parsed.origin).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });

  it('withOrigin replaces only the origin and round-trips', () => {
    fc.assert(
      fc.property(depRef, origin, (dep, o) => {
        const moved = DepRef.from(dep).withOrigin(o);
        expect(moved.toJSON()).toEqual({ ...dep, origin: o });
        expect(DepRef.parse(moved.toString()).toJSON()).toEqual(moved.toJSON());
      }),
      { numRuns: 200 },
    );
  });
});
