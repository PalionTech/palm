/** Undeploy removes exactly the lock entry's files and fragments, nothing else. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTarget } from '../../src/targets/index.js';
import {
  allKinds,
  cleanupTmp,
  exists,
  fakeEnv,
  install,
  lockEntryOf,
  makeSource,
  mkEntity,
  read,
  readJson,
  tmpDir,
  write,
} from './helpers.js';

afterEach(cleanupTmp);

async function hookInstalled() {
  const root = await tmpDir();
  const src = await makeSource();
  const k = allKinds(src).find((e) => e.label === 'hook')!;
  const target = createTarget('claude', fakeEnv(root));
  const done = await install(target, {
    ...k,
    scope: 'project',
    scopeRoot: root,
    sourceRoot: src.root,
  });
  return { root, target, ...done };
}

describe('undeploy', () => {
  it('removes only the listed files: a file palm did not write stays, and its directory with it', async () => {
    const { root, target, entry } = await hookInstalled();
    const assets = path.join(root, '.palm/assets/acme__kit/fmt/plugins/fmt/hooks');
    await write(path.join(assets, 'notes.txt'), 'mine\n');
    await target.undeploy(entry, 'project', root, false);
    expect(await exists(path.join(assets, 'format.sh'))).toBe(false);
    expect(await read(path.join(assets, 'notes.txt'))).toBe('mine\n');
    // the settings file palm created held only its fragments: left as {}, it is deleted
    expect(await exists(path.join(root, '.claude/settings.json'))).toBe(false);
  });

  it('prunes emptied directories up to .palm/assets and never the harness dir', async () => {
    const { root, target, entry } = await hookInstalled();
    await write(path.join(root, '.claude/agents/mine.md'), 'x');
    await target.undeploy(entry, 'project', root, false);
    expect(await exists(path.join(root, '.palm/assets/acme__kit'))).toBe(false);
    expect(await exists(path.join(root, '.palm/assets'))).toBe(true);
    expect(await exists(path.join(root, '.claude'))).toBe(true);
  });

  it('unmerges only the listed fragments, found by key; other entries and keys survive', async () => {
    const { root, target, entry } = await hookInstalled();
    const settings = path.join(root, '.claude/settings.json');
    const doc = (await readJson(settings)) as { hooks: Record<string, unknown[]> };
    doc.hooks.Stop = [{ hooks: [{ type: 'command', command: 'mine' }] }];
    (doc as Record<string, unknown>).theme = 'dark';
    await write(settings, JSON.stringify(doc));
    // only the first fragment is listed: the second one stays
    await target.undeploy(
      { ...entry, files: [], merged: entry.merged?.slice(0, 1) },
      'project',
      root,
      false,
    );
    expect(await readJson(settings)).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }],
      },
      theme: 'dark',
    });
  });

  it('files outside this target roots are left to their own target', async () => {
    const root = await tmpDir();
    await write(path.join(root, '.agents/skills/demo/SKILL.md'), 'codex copy\n');
    const entry = lockEntryOf(
      mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } }),
      {
        files: ['.agents/skills/demo/SKILL.md'],
        merged: [],
      },
    );
    await createTarget('claude', fakeEnv(root)).undeploy(entry, 'project', root, false);
    expect(await read(path.join(root, '.agents/skills/demo/SKILL.md'))).toBe('codex copy\n');
  });

  it('a listed path that resolves outside the scope is refused; a dry run removes nothing', async () => {
    const { root, target, entry } = await hookInstalled();
    await target.undeploy(entry, 'project', root, true);
    expect(
      await exists(path.join(root, '.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh')),
    ).toBe(true);
    const outside = await tmpDir('palm-outside-');
    await write(path.join(outside, 'victim.sh'), 'keep\n');
    const agents = path.join(root, '.claude/agents');
    await fs.mkdir(path.dirname(agents), { recursive: true });
    await fs.symlink(outside, agents);
    const bad = { ...entry, files: ['.claude/agents/victim.sh'], merged: [] };
    await expect(target.undeploy(bad, 'project', root, false)).rejects.toMatchObject({
      code: 'E_IO',
    });
    expect(await read(path.join(outside, 'victim.sh'))).toBe('keep\n');
  });

  it('a lock path that tries to leave the root is ignored', async () => {
    const root = path.join(await tmpDir(), 'project');
    const victim = path.join(path.dirname(root), 'victim');
    await write(path.join(victim, 'data'), 'keep me');
    const entry = lockEntryOf(
      mkEntity({ kind: 'skill', skill: { name: 'x', description: 'd' } }, 'x'),
      {
        files: ['../victim/data'],
        merged: [],
      },
    );
    await createTarget('claude', fakeEnv(root)).undeploy(entry, 'project', root, false);
    expect(await read(path.join(victim, 'data'))).toBe('keep me');
  });
});
