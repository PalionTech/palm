/**
 * Rulings settled at integration, proven against the built binary with real git sources (local
 * bare repositories), real targets and a real cache. Ruling 23: an edit is found offline against
 * the lock's render hash; a file palm cannot check (the locked commit is gone) is kept, never
 * overwritten, and the run exits 1 naming the command that overwrites it.
 */
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Files, Machine, writeFiles } from './world.js';

const skill = (name: string, body: string): Files => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
});

const version = (body: string): Files => ({ ...skill('tdd', body), ...skill('review', body) });

let m: Machine;
beforeEach(async () => {
  m = await Machine.create();
});
afterEach(async () => {
  await m.dispose();
});

describe('ruling 23: edits are found against the render hash, offline', () => {
  it('keeps an edited file when the locked commit is gone, and updates an unedited one', async () => {
    const url = await m.source('kit', { 'v1.0.0': version('one'), 'v2.0.0': version('two') });
    const p = await m.project('app');
    const install = await m.palm(p, 'install', `${url}#v1.0.0`, 'tdd', 'review', '--as', 'kit');
    expect(install.code, install.all).toBe(0);
    const sha = /sha: ([0-9a-f]{40})/.exec(readFileSync(join(p, 'palm.lock.yaml'), 'utf8'))?.[1];
    await writeFiles(p, { '.claude/skills/tdd/SKILL.md': 'my edit\n' });
    // The source's history is rewritten without the locked commit, and the cache is emptied.
    await rm(join(m.root, 'remotes', 'kit.git'), { recursive: true, force: true });
    await rm(join(m.root, 'src', 'kit'), { recursive: true, force: true });
    await m.source('kit', { 'v2.0.0': version('two') });
    await rm(join(m.palmHome, 'cache'), { recursive: true, force: true });
    const manifest = readFileSync(join(p, 'palm.yaml'), 'utf8');
    await writeFiles(p, { 'palm.yaml': manifest.replace('ref: v1.0.0', 'ref: v2.0.0') });

    const sync = await m.palm(p, 'install', '--yes');
    expect(sync.code, sync.all).toBe(1);
    expect(sync.stdout).toMatch(/^! modified \(kept\) +skill +tdd/m);
    expect(sync.all).toContain(
      `locked commit ${sha?.slice(0, 7)} unavailable; palm install kit skill:tdd --force overwrites`,
    );
    expect(readFileSync(join(p, '.claude/skills/tdd/SKILL.md'), 'utf8')).toBe('my edit\n');
    expect(readFileSync(join(p, '.claude/skills/review/SKILL.md'), 'utf8')).toContain('two');

    const forced = await m.palm(p, 'install', 'kit', 'skill:tdd', '--force');
    expect(forced.code, forced.all).toBe(0);
    expect(readFileSync(join(p, '.claude/skills/tdd/SKILL.md'), 'utf8')).toContain('two');
  });

  it('applies a server changed in palm.yaml when its merged entry is as palm wrote it, else keeps it', async () => {
    const p = await m.project('app');
    const add = await m.palm(p, 'install', 'mcp', 'docs', '--url', 'https://example.com/mcp');
    expect(add.code, add.all).toBe(0);
    const manifest = readFileSync(join(p, 'palm.yaml'), 'utf8');
    const moveTo = (url: string) =>
      writeFiles(p, { 'palm.yaml': manifest.replace('https://example.com/mcp', url) });

    await moveTo('https://example.com/v2/mcp');
    const sync = await m.palm(p, 'install');
    expect(sync.code, sync.all).toBe(0);
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toContain('https://example.com/v2/mcp');

    const edited = readFileSync(join(p, '.mcp.json'), 'utf8').replace('/v2/', '/mine/');
    await writeFiles(p, { '.mcp.json': edited });
    await moveTo('https://example.com/v3/mcp');
    const kept = await m.palm(p, 'install');
    expect(kept.code, kept.all).toBe(1);
    expect(kept.all).toContain(
      'palm cannot rebuild what it wrote from palm.yaml; palm install --force overwrites',
    );
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toBe(edited);
  });
});
