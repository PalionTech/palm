import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEntry, loadLock, removeEntry, saveLock, upsertEntry } from '../../src/core/lockfile.js';
import type { LockEntry } from '../../src/core/types.js';
import { removeDir, tempDir } from './helpers.js';

function entry(name: string, origin = 'o', extra: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: 'skill',
    name,
    origin,
    path: `skills/${name}`,
    contentHash: 'sha256:x',
    installedAt: '2026-01-01T00:00:00.000Z',
    targets: ['claude'],
    files: [`.claude/skills/${name}/SKILL.md`],
    ...extra,
  };
}

describe('lockfile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  it('is empty when missing', async () => {
    expect(await loadLock(join(dir, 'palm.lock.yaml'))).toEqual({ version: 1, entries: [] });
  });

  it('upserts by kind+name+origin and removes', () => {
    let lock = upsertEntry({ version: 1, entries: [] }, entry('a'));
    lock = upsertEntry(lock, entry('a', 'o', { contentHash: 'sha256:y' }));
    lock = upsertEntry(lock, entry('a', 'p'));
    expect(lock.entries).toHaveLength(2);
    expect(findEntry(lock, 'skill', 'a', 'o')?.contentHash).toBe('sha256:y');
    expect(findEntry(lock, 'skill', 'A')).toBeDefined();
    expect(findEntry(lock, 'agent', 'a')).toBeUndefined();
    expect(removeEntry(lock, 'skill', 'a', 'p').entries).toHaveLength(1);
    expect(removeEntry(lock, 'skill', 'a').entries).toHaveLength(0);
  });

  it('saves and loads', async () => {
    const file = join(dir, 'palm.lock.yaml');
    const lock = upsertEntry(upsertEntry({ version: 1, entries: [] }, entry('b')), entry('a', 'o', { via: 'plugin:p', merged: [] }));
    await saveLock(file, lock);
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^# palm lockfile/);
    expect(text).not.toContain('merged');
    const back = await loadLock(file);
    expect(back.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(back.entries[0]!.via).toBe('plugin:p');
  });
});
