import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheDir,
  cleanCache,
  getIndex,
  INDEX_FORMAT,
  readCachedIndex,
} from '../../src/core/cache.js';
import { fetchSource } from '../../src/core/git.js';
import type { ScanResult, Source, SourceCheckout } from '../../src/core/types.js';
import { SourceRef } from '../../src/domain/source.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import { makeRemote } from './gitrepo.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => removeDir(sb.root));

function counting(): { scan: (root: string, s: Source) => Promise<ScanResult>; calls: Source[] } {
  const calls: Source[] = [];
  return {
    calls,
    async scan(_root, s) {
      calls.push(s);
      return {
        entities: [
          {
            kind: 'skill',
            name: 'a',
            path: 'a',
            source: 'whatever',
            def: { kind: 'skill', skill: { name: 'a', description: 'A' } },
          },
        ],
        warnings: ['w'],
        detected: 'convention',
      };
    },
  };
}

describe('getIndex', () => {
  it('caches a git index by sha and layout, under each source name, scanning once', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const src: Source = { name: 'r', type: 'git', url: remote.bare, ref: '^1' };
    const co = await fetchSource(ctx, src);
    const fake = counting();
    const index = await getIndex(ctx, co, { scan: fake.scan });
    expect(index).toMatchObject({
      source: 'r',
      sourceId: co.sourceId,
      sha: co.sha,
      ref: 'v1.1.0',
      detected: 'convention',
    });
    expect(index.entities[0]?.source).toBe('r');
    expect(fake.calls[0]?.ref).toBe('v1.1.0'); // versions come from the tag checked out
    const file = new SourceRef(src).indexFile(cacheDir(ctx.paths), co.sha as string);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.format).toBe(INDEX_FORMAT);
    const other: SourceCheckout = { ...co, source: { ...src, name: 'other' } };
    expect((await getIndex(ctx, other, { scan: fake.scan })).entities[0]?.source).toBe('other');
    expect(fake.calls).toHaveLength(1);
    const layout: SourceCheckout = { ...co, source: { ...src, layout: { skills: ['*'] } } };
    await getIndex(ctx, layout, { scan: fake.scan });
    await getIndex(ctx, co, { scan: fake.scan, refresh: true });
    expect(fake.calls).toHaveLength(3);
    expect(
      await readCachedIndex(ctx, new SourceRef({ ...src, name: 'x' }), co.sha as string),
    ).toMatchObject({ source: 'x' });
  });

  it('keys a local index by its tree hash, so an edit rescans', async () => {
    const ctx = await makeContext(sb);
    const kit = join(sb.project, 'kit');
    await write(join(kit, 'skills/a/SKILL.md'), 'a');
    const src: Source = { name: './kit', type: 'local', path: kit };
    const fake = counting();
    await getIndex(ctx, await fetchSource(ctx, src), { scan: fake.scan });
    await getIndex(ctx, await fetchSource(ctx, src), { scan: fake.scan });
    expect(fake.calls).toHaveLength(1);
    await write(join(kit, 'skills/a/SKILL.md'), 'edited');
    const edited = await getIndex(ctx, await fetchSource(ctx, src), { scan: fake.scan });
    expect(fake.calls).toHaveLength(2);
    expect(edited.tree).toMatch(/^sha256:/);
  });

  it('treats a malformed or older cache file as a miss and rescans once', async () => {
    const ctx = await makeContext(sb);
    const kit = join(sb.project, 'kit');
    await write(join(kit, 'x.md'), 'x');
    const src: Source = { name: './kit', type: 'local', path: kit };
    const co = await fetchSource(ctx, src);
    const file = new SourceRef(src).indexFile(cacheDir(ctx.paths), co.tree as string);
    const fake = counting();
    for (const bad of [
      '{',
      JSON.stringify({
        format: 2,
        cacheKey: 'k',
        entities: [],
        warnings: [],
        detected: 'convention',
      }),
      JSON.stringify({
        format: INDEX_FORMAT,
        cacheKey: 'k',
        entities: [{ kind: 'skill' }],
        warnings: [],
        detected: 'x',
      }),
    ]) {
      await write(file, bad);
      await getIndex(ctx, co, { scan: fake.scan });
    }
    expect(fake.calls).toHaveLength(3);
    expect(await readCachedIndex(ctx, new SourceRef(src), 'sha256:0000000000')).toBeUndefined();
  });
});

describe('cleanCache', () => {
  it('removes the cache and reports its size; nothing to remove is 0', async () => {
    const ctx = await makeContext(sb);
    expect(await cleanCache(ctx.paths)).toEqual({ removedBytes: 0 });
    await write(join(cacheDir(ctx.paths), 'x', 'a.json'), '12345');
    await writeFile(join(cacheDir(ctx.paths), 'b'), 'abc');
    expect(await cleanCache(ctx.paths)).toEqual({ removedBytes: 8 });
    expect(existsSync(cacheDir(ctx.paths))).toBe(false);
  });
});
