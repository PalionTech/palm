import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256, short } from '../../src/lib/digest.js';
import { realpathInside } from '../../src/lib/fs.js';
import { canonicalJson } from '../../src/lib/json.js';
import { isSafeName, sanitizeSourceDir } from '../../src/lib/names.js';
import { entropyBitsPerChar } from '../../src/lib/text.js';
import { stringifyYaml, writeYamlFile } from '../../src/lib/yaml.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('canonicalJson', () => {
  it('sorts keys at every depth, drops undefined keys and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('gives equal text for equal data in any key order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe('entropyBitsPerChar', () => {
  it('is 0 for empty or uniform text and high for random tokens', () => {
    expect(entropyBitsPerChar('')).toBe(0);
    expect(entropyBitsPerChar('aaaa')).toBe(0);
    expect(entropyBitsPerChar('abab')).toBeCloseTo(1);
    expect(entropyBitsPerChar('Zx9Qp2LmT7vR4sKd8WnB')).toBeGreaterThan(3.5);
    expect(entropyBitsPerChar('password-password')).toBeLessThan(3.5);
  });
});

describe('sanitizeSourceDir', () => {
  it.each([
    ['owner/repo', 'owner__repo'],
    ['trailofbits/skills', 'trailofbits__skills'],
    ['./agent-kit', 'agent-kit'],
    ['./tools/kit', 'tools__kit'],
    ['acme-kit', 'acme-kit'],
    ['../outside', 'outside'],
    ['.', 'source'],
    ['weird name!', 'weird-name-'],
  ])('%s → %s', (name, dir) => {
    expect(sanitizeSourceDir(name)).toBe(dir);
  });

  it('always yields one safe path segment', () => {
    fc.assert(fc.property(fc.string(), (s) => isSafeName(sanitizeSourceDir(s))));
  });
});

describe('digest', () => {
  it('hashes as sha256:<hex> and shortens to 8 hex digits', () => {
    const h = sha256('abc');
    expect(h).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(short(h)).toBe('ba7816bf');
    expect(short('a7cc7911ff', 4)).toBe('a7cc');
  });
});

describe('realpathInside', () => {
  it('resolves the deepest existing ancestor and keeps the missing rest', async () => {
    const root = await tmpDir();
    const r = await realpathInside(join(root, 'a/b/c.txt'), [root]);
    expect(r).toEqual({ real: join(root, 'a/b/c.txt'), inside: true, dangling: false });
  });

  it('follows a symlinked directory out of the roots', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await symlink(outside, join(root, '.claude'));
    const r = await realpathInside(join(root, '.claude/skills/x/SKILL.md'), [root]);
    expect(r.real).toBe(join(outside, 'skills/x/SKILL.md'));
    expect(r.inside).toBe(false);
  });

  it('follows a dangling link to where its target would be', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await symlink(join(root, 'target-dir'), join(root, 'in-link'));
    await symlink(join(outside, 'gone'), join(root, 'out-link'));
    expect(await realpathInside(join(root, 'in-link/f'), [root])).toEqual({
      real: join(root, 'target-dir/f'),
      inside: true,
      dangling: true,
    });
    const out = await realpathInside(join(root, 'out-link'), [root]);
    expect(out).toMatchObject({ real: join(outside, 'gone'), inside: false, dangling: true });
  });

  it('resolves the roots too, and a root itself counts as inside', async () => {
    const real = await tmpDir();
    const alias = join(await tmpDir(), 'alias');
    await symlink(real, alias);
    await mkdir(join(real, 'x'));
    expect((await realpathInside(join(real, 'x'), [alias])).inside).toBe(true);
    expect((await realpathInside(real, [real])).inside).toBe(true);
  });
});

describe('stringifyYaml flow and comment', () => {
  it('writes the collections the predicate picks in flow style, under a comment', () => {
    const text = stringifyYaml(
      { a: { b: [1, 2], c: { d: 1 } }, e: [{ f: 1 }] },
      { flow: (p) => p.join('.') === 'a.b' || (p[0] === 'e' && p.length === 2), comment: 'hi' },
    );
    expect(text).toBe('# hi\na:\n  b: [1, 2]\n  c:\n    d: 1\ne:\n  - {f: 1}\n');
  });

  it('flows only the nodes a patch creates, keeping the file style', async () => {
    const file = join(await tmpDir(), 'm.yaml');
    await write(file, 'list:\n  - x: 1\n');
    await writeYamlFile(file, { list: [{ x: 1 }, { y: 2 }] }, { flow: (p) => p.length === 2 });
    expect(await read(file)).toBe('list:\n  - x: 1\n  - {y: 2}\n');
  });
});
