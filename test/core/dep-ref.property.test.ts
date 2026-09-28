import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDepRef, parseDepRef } from '../../src/core/manifest.js';
import type { DepRef } from '../../src/core/types.js';

const lower = 'abcdefghijklmnopqrstuvwxyz0123456789';
const slugChar = fc.constantFrom(...`${lower}-_.`);
const slug = fc
  .tuple(fc.constantFrom(...lower), fc.string({ unit: slugChar, maxLength: 20 }))
  .map(([first, rest]) => first + rest);

/** Entity names: plain slugs, registry names (`io.github.acme/weather`) and `@scope/pkg`. */
const name = fc.oneof(
  slug,
  fc
    .tuple(fc.array(slug, { minLength: 1, maxLength: 3 }), slug)
    .map(([ns, n]) => `${ns.join('.')}/${n}`),
  fc.tuple(slug, slug).map(([scope, n]) => `@${scope}/${n}`),
);
/** Origin aliases never contain `/`, `@` or `#`. */
const origin = slug;
/** Git refs: tags, branches with slashes, shas. */
const ref = fc
  .tuple(slug, fc.array(slug, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail].join('/'));

const depRef: fc.Arbitrary<DepRef> = fc
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

describe('parseDepRef / formatDepRef (property)', () => {
  it('parses every formatted <name>[@<origin>][#<ref>] back to the same ref and string', () => {
    fc.assert(
      fc.property(depRef, (dep) => {
        const s = formatDepRef(dep);
        const parsed = parseDepRef(s);
        expect(parsed).toEqual(dep);
        expect(formatDepRef(parsed)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });
});
