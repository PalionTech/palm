/**
 * The cached index (core/cache) is only trusted when its shape checks out: anything else is a
 * cache miss and the origin is rescanned, never a crash.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIndex, indexFilePath, readCachedIndex } from '../../src/core/cache.js';
import type { EngineDeps, OriginSpec, ScanResult } from '../../src/core/types.js';
import { makeRemote } from '../core/gitrepo.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

function countingScan(): EngineDeps['scan'] & { calls: number } {
  const fn = (async (_root: string, spec: OriginSpec): Promise<ScanResult> => {
    fn.calls++;
    return {
      entities: [
        {
          kind: 'skill',
          name: 'a',
          path: 'skills/a',
          origin: spec.alias,
          def: { kind: 'skill', skill: { name: 'a', description: 'A' } },
          issues: [
            { code: 'hidden-unicode', severity: 'warning', message: 'skills/a/SKILL.md: …' },
          ],
        },
      ],
      warnings: ['hidden-unicode: skill "a" (warning): skills/a/SKILL.md: …'],
      detected: 'convention',
    };
  }) as EngineDeps['scan'] & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('index cache shape check', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(async () => removeDir(sb.root));

  it('reuses a well-formed cache and rescans a malformed or older one', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare };
    const scan = countingScan();
    const first = await getIndex(ctx, spec, { scan });
    expect(first.entities[0]?.issues).toHaveLength(1);
    const file = indexFilePath(ctx, spec);
    const good = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(good.format).toBe(2);

    const cached = await getIndex(ctx, spec, { scan });
    expect(scan.calls).toBe(1);
    expect(cached.entities).toEqual(first.entities);
    expect(cached).not.toHaveProperty('format');
    expect(cached).not.toHaveProperty('cacheKey');

    const bad: unknown[] = [
      '{ truncated',
      {},
      { ...good, format: 1 },
      { ...good, format: undefined },
      { ...good, entities: 'nope' },
      { ...good, warnings: null },
      { ...good, entities: [{ kind: 'skill', name: 'a' }] },
      { ...good, entities: [null] },
      [],
    ];
    for (const [i, content] of bad.entries()) {
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
      const idx = await getIndex(ctx, spec, { scan });
      expect(idx.entities.map((e) => e.name)).toEqual(['a']);
      expect(scan.calls, `case ${i}`).toBe(i + 2);
    }
  });

  it('readCachedIndex (get/describe origin) applies the same check, without fetching', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare };
    expect(await readCachedIndex(ctx, spec)).toBeUndefined();
    const scanned = await getIndex(ctx, spec, { scan: countingScan() });
    expect(await readCachedIndex(ctx, spec)).toEqual(scanned);
    const file = indexFilePath(ctx, spec);
    const good = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    // an older palm's index: entities present, but no format
    await writeFile(file, JSON.stringify({ ...good, format: undefined }));
    expect(await readCachedIndex(ctx, spec)).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...good, entities: [{ kind: 'skill' }] }));
    expect(await readCachedIndex(ctx, spec)).toBeUndefined();
  });
});
