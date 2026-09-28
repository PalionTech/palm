import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getIndex } from '../../src/core/cache.js';
import { installEntities } from '../../src/engine/install.js';
import { duplicateWarnings, findCandidates, getEntityInfo } from '../../src/engine/query.js';
import { scanOrigin } from '../../src/index/scan.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'cursor-monorepo-like');

describe('duplicate names across plugins of one origin', () => {
  let sb: Sandbox;
  afterEach(async () => removeDir(sb.root));

  it('keeps the first copy, surfaces the warning in info, and name@origin resolves the survivor', async () => {
    sb = await sandbox();
    const ctx = await makeContext(sb);
    ctx.config.origins.push({ alias: 'mono', type: 'local', path: FIXTURE });

    const index = await getIndex(ctx, ctx.config.origins[0]!, { scan: scanOrigin });
    const dups = duplicateWarnings(index, 'skill', 'tdd');
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatch(
      /^duplicate skill "tdd" at .*team-kit.* ignored \(already indexed from .*pstack/,
    );
    expect(duplicateWarnings(index, 'agent')).toEqual([]);

    const cands = await findCandidates(ctx, { kind: 'skill', name: 'tdd' }, { origin: 'mono' });
    expect(cands.map((e) => `${e.name}@${e.origin} ${e.path}`)).toEqual([
      'tdd@mono pstack/skills/tdd',
    ]);

    const info = await getEntityInfo(
      ctx,
      { kind: 'skill', name: 'tdd' },
      { origin: 'mono', scope: 'project' },
    );
    expect(info.entity?.path).toBe('pstack/skills/tdd');
    expect(info.warnings).toEqual(dups);

    const r = await installEntities(ctx, [{ kind: 'skill', spec: 'tdd@mono' }], {
      scope: 'project',
      targets: ['claude'],
    });
    expect(r.outcomes[0]!.entry.path).toBe('pstack/skills/tdd');
  });
});
