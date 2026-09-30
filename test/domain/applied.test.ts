import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Applied } from '../../src/domain/applied.js';
import { Lock } from '../../src/domain/lock.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { cleanupTmp, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('Applied', () => {
  const paths = new ScopePaths('global', '/h', '/h/.palm', { CLAUDE_CONFIG_DIR: '/cc' });
  const lock = new Lock({}, [
    {
      kind: 'skill',
      name: 'tdd',
      source: 'a/b',
      path: 'skills/tdd',
      content: 'sha256:c',
      render: { claude: 'sha256:r' },
      files: ['<claude>/skills/tdd/SKILL.md'],
      merged: [
        { file: '<home>/.claude.json', at: '/mcpServers/docs', id: 'palm:mcp:docs:0', key: 'docs' },
      ],
    },
  ]);

  it('records real paths, hashes, fragments, the lock hash and the homes', () => {
    const a = Applied.fromLock(lock, paths, new Map([['/cc/skills/tdd/SKILL.md', 'sha256:f']]));
    expect(a.record).toMatchObject({
      lockHash: lock.hash(),
      files: [{ path: '/cc/skills/tdd/SKILL.md', hash: 'sha256:f' }],
      merged: [
        { file: '/h/.claude.json', at: '/mcpServers/docs', key: 'docs', entry: 'skill:tdd@a/b' },
      ],
      homes: { home: '/h', claude: '/cc' },
    });
    expect(a.fileHash('/cc/skills/tdd/SKILL.md')).toBe('sha256:f');
    expect(a.fileHash('/nope')).toBeUndefined();
    expect(
      Applied.fromLock(lock, paths, new Map()).fileHash('/cc/skills/tdd/SKILL.md'),
    ).toBeUndefined();
  });

  it('saves (mode 0600) and loads back; missing is empty; malformed is empty with a warning', async () => {
    const file = join(await tmpDir(), 'applied.yaml');
    const a = Applied.fromLock(lock, paths, new Map([['/cc/skills/tdd/SKILL.md', 'sha256:f']]));
    await a.save(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const loaded = await Applied.load(file);
    expect(loaded.record).toEqual(a.record);
    expect(loaded.warnings()).toEqual([]);
    expect((await Applied.load(join(file, '..', 'missing.yaml'))).record.files).toEqual([]);
    await write(file, 'files: nope\n');
    const bad = await Applied.load(file);
    expect(bad.record.files).toEqual([]);
    expect(bad.warnings()[0]).toMatch(/ignored .*applied\.yaml/);
    await write(file, 'a: [\n');
    expect((await Applied.load(file)).warnings()).toHaveLength(1);
  });
});
