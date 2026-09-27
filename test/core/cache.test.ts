import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAllIndexes, getIndex, invalidateIndex } from '../../src/core/cache.js';
import { originId } from '../../src/core/config.js';
import type { OriginSpec, ScanOriginFn, ScanResult } from '../../src/core/types.js';
import { makeRemote } from './gitrepo.js';
import { makeContext, removeDir, sandbox, writeFiles, type FakeLogger, fakeLogger, type Sandbox } from './helpers.js';

function countingScan(): ScanOriginFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (root: string, spec: OriginSpec): Promise<ScanResult> => {
    calls.push(root);
    return {
      entities: [{ kind: 'skill', name: 'a', path: 'a.txt', origin: spec.alias, def: { kind: 'skill', skill: { name: 'a', description: 'A' } } }],
      warnings: [],
      detected: 'convention',
    };
  }) as ScanOriginFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('index cache', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(async () => removeDir(sb.root));

  it('caches git origin indexes by sha and rescans on refresh', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const scan = countingScan();
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare };
    const idx = await getIndex(ctx, spec, { scan });
    expect(idx).toMatchObject({ origin: 'r', sha: remote.shas['v1.1.0'], ref: 'v1.1.0', detected: 'convention' });
    expect(existsSync(join(sb.palmHome, 'cache', `${originId(spec)}.index.json`))).toBe(true);
    await getIndex(ctx, spec, { scan });
    expect(scan.calls).toHaveLength(1);
    // alias rewrite on read
    const renamed = await getIndex(ctx, { ...spec, alias: 'other' }, { scan });
    expect(renamed.entities[0]!.origin).toBe('other');
    expect(scan.calls).toHaveLength(1);
    await getIndex(ctx, spec, { scan, refresh: true });
    expect(scan.calls).toHaveLength(2);
    await invalidateIndex(ctx, spec);
    await getIndex(ctx, spec, { scan });
    expect(scan.calls).toHaveLength(3);
  });

  it('rescans local origins every time and skips broken origins', async () => {
    await writeFiles(join(sb.root, 'local'), { 'a.txt': 'x' });
    const log: FakeLogger = fakeLogger();
    const ctx = await makeContext(sb, { log });
    ctx.config.origins.push({ alias: 'loc', type: 'local', path: join(sb.root, 'local') });
    ctx.config.origins.push({ alias: 'gone', type: 'local', path: join(sb.root, 'missing') });
    const scan = countingScan();
    const all = await getAllIndexes(ctx, { scan });
    expect(all.map((i) => i.origin)).toEqual(['loc']);
    await getAllIndexes(ctx, { scan });
    expect(scan.calls).toHaveLength(2);
    expect(log.messages.some((m) => m.level === 'warn' && m.msg.includes('gone'))).toBe(true);
  });
});
