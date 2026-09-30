/**
 * The Applier: collision policy (adopt identical, refuse foreign before any write), fragments
 * found by (at, key), the scope boundary, dry runs, rollback of bytes and modes, and the modes
 * of files that can hold secrets.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Rendered, Scope, TargetId } from '../../src/core/types.js';
import { parseMergedRecord } from '../../src/domain/merged-record.js';
import { createTarget } from '../../src/targets/index.js';
import { mergedRecordState } from '../../src/targets/merged-state.js';
import {
  allKinds,
  cleanupTmp,
  exists,
  fakeEnv,
  makeSource,
  read,
  readJson,
  renderInput,
  snapshot,
  tmpDir,
  write,
} from './helpers.js';

const io = vi.hoisted(() => ({ failOn: undefined as ((file: string) => boolean) | undefined }));

vi.mock('../../src/lib/fs.js', async (orig) => {
  const actual = (await orig()) as typeof import('../../src/lib/fs.js');
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (io.failOn?.(args[0])) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      return actual.writeFileAtomic(...args);
    },
  };
});

afterEach(async () => {
  io.failOn = undefined;
  await cleanupTmp();
});

async function rendered(
  id: TargetId,
  label: string,
  root: string,
  scope: Scope = 'project',
): Promise<Rendered> {
  const src = await makeSource();
  const k = allKinds(src).find((e) => e.label === label);
  if (!k) throw new Error(label);
  const input = renderInput({ ...k, scope, scopeRoot: root, sourceRoot: src.root });
  return createTarget(id, fakeEnv(root)).render(input);
}

function apply(
  id: TargetId,
  root: string,
  r: Rendered,
  over: { owned?: string[]; force?: boolean; dryRun?: boolean } = {},
) {
  return createTarget(id, fakeEnv(root)).apply({
    rendered: r,
    scopeRoot: root,
    owned: over.owned ?? [],
    force: over.force ?? false,
    dryRun: over.dryRun ?? false,
  });
}

describe('whole files', () => {
  it('adopts an identical file, refuses a foreign different one before writing anything', async () => {
    const root = await tmpDir();
    const r = await rendered('claude', 'skill', root);
    const skill = (rel: string) => path.join(root, '.claude/skills/demo', rel);
    await write(skill('SKILL.md'), Buffer.from(r.files[0]!.data).toString('utf8'));
    await write(skill('references/notes.md'), '# mine\n');
    await expect(apply('claude', root, r)).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: 'refusing to overwrite .claude/skills/demo/references/notes.md',
      retryWith: '--force',
    });
    expect(await exists(skill('scripts/run.sh'))).toBe(false); // checked before any write
    expect(await read(skill('references/notes.md'))).toBe('# mine\n');

    const owned = await apply('claude', root, r, {
      owned: ['.claude/skills/demo/references/notes.md'],
    });
    expect(owned.adopted).toEqual(['.claude/skills/demo/SKILL.md']);
    expect(owned.files).toEqual(r.files.map((f) => f.path));
    expect(await read(skill('references/notes.md'))).toBe('# Notes\n');
    expect((await fs.stat(skill('scripts/run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('force replaces a foreign file', async () => {
    const root = await tmpDir();
    const r = await rendered('claude', 'agent', root);
    await write(path.join(root, '.claude/agents/demo.md'), 'mine\n');
    await expect(apply('claude', root, r)).rejects.toMatchObject({ code: 'E_CONFLICT' });
    const forced = await apply('claude', root, r, { force: true });
    expect(forced.adopted).toEqual([]);
    expect(await read(path.join(root, '.claude/agents/demo.md'))).toContain('name: demo');
  });

  it('a dry run checks the same and writes nothing', async () => {
    const root = await tmpDir();
    const r = await rendered('cursor', 'hook', root);
    const before = await snapshot(root);
    const dry = await apply('cursor', root, r, { dryRun: true });
    expect(await snapshot(root)).toEqual(before);
    expect(await apply('cursor', root, r)).toEqual(dry);
    await write(path.join(root, '.cursor/agents/demo.md'), 'mine\n');
    const agent = await rendered('cursor', 'agent', root);
    await expect(apply('cursor', root, agent, { dryRun: true })).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
  });

  it('a destination that resolves outside the scope through a link is refused', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    await fs.symlink(outside, path.join(root, '.claude', 'skills'));
    const r = await rendered('claude', 'skill', root);
    await expect(apply('claude', root, r)).rejects.toMatchObject({
      code: 'E_IO',
      message: expect.stringMatching(
        /refusing to write \.claude\/skills\/demo\/.*resolves to .*outside/,
      ),
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('a link inside the scope is written through, never replaced', async () => {
    const root = await tmpDir();
    await write(path.join(root, 'dotfiles/settings.json'), '{"theme":"dark"}');
    await fs.mkdir(path.join(root, '.claude'), { recursive: true });
    const link = path.join(root, '.claude', 'settings.json');
    await fs.symlink(path.join(root, 'dotfiles/settings.json'), link);
    await apply('claude', root, await rendered('claude', 'hook', root));
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readJson(path.join(root, 'dotfiles/settings.json'))).toMatchObject({
      theme: 'dark',
      hooks: { SessionStart: [{ hooks: [{ command: 'echo hi' }] }] },
    });
  });

  it('a directory where a file goes is E_CONFLICT', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, '.claude/agents/demo.md'), { recursive: true });
    await expect(
      apply('claude', root, await rendered('claude', 'agent', root)),
    ).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: expect.stringContaining('not a regular file'),
    });
  });
});

describe('fragments by (at, key)', () => {
  it('held is a no-op; a changed value under the key is E_CONFLICT unless owned or forced', async () => {
    const root = await tmpDir();
    const r = await rendered('claude', 'hook', root);
    await apply('claude', root, r);
    const settings = path.join(root, '.claude/settings.json');
    const first = await read(settings);
    await apply('claude', root, r);
    expect(await read(settings)).toBe(first); // held: nothing appended twice

    const frag = r.fragments[0]!;
    const rec = parseMergedRecord({ ...frag, file: settings });
    expect(await mergedRecordState(rec)).toBe('held');
    const doc = JSON.parse(first) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ timeout: number }> }> };
    };
    doc.hooks.PostToolUse[0]!.hooks[0]!.timeout = 99;
    await write(settings, JSON.stringify(doc));
    expect(await mergedRecordState(rec)).toBe('changed');
    await expect(apply('claude', root, r)).rejects.toMatchObject({ code: 'E_CONFLICT' });

    const owned = [`${frag.file}#${frag.at}#${frag.key}`];
    await apply('claude', root, r, { owned });
    expect(await mergedRecordState(rec)).toBe('held');
    expect((await readJson(settings)) as object).toEqual(JSON.parse(first));
  });

  it('a user MCP server under the same name is a conflict; force replaces it', async () => {
    const root = await tmpDir();
    await write(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'mine' } } }),
    );
    const r = await rendered('claude', 'mcp stdio', root);
    await expect(apply('claude', root, r)).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: expect.stringContaining('/mcpServers/gh'),
    });
    await apply('claude', root, r, { force: true });
    expect(await readJson(path.join(root, '.mcp.json'))).toMatchObject({
      mcpServers: { gh: { command: 'npx' } },
    });
  });

  it('merged lists every fragment by (file, at, id, key); no value is recorded', async () => {
    const root = await tmpDir();
    const r = await rendered('codex', 'instruction', root);
    const res = await apply('codex', root, r);
    expect(res.merged).toEqual([
      {
        file: 'AGENTS.md',
        at: 'block:instruction:demo',
        id: 'palm:instruction:demo:0',
        key: 'instruction:demo',
        created: true,
      },
    ]);
    const again = await apply('codex', root, r);
    expect(again.merged[0]).not.toHaveProperty('created');
  });
});

describe('rollback', () => {
  it('restores every byte and mode after a failing apply', async () => {
    const root = await tmpDir();
    const settings = path.join(root, '.claude/settings.json');
    await write(settings, '{"theme":"dark"}\n', 0o600);
    const asset = path.join(root, '.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh');
    await write(asset, 'old\n', 0o700);
    const before = await snapshot(root);
    const r = await rendered('claude', 'hook', root);
    // the last closure file fails: the settings merge and the other scripts are rolled back
    io.failOn = (file) => file.endsWith(`${path.sep}util.sh`);
    await expect(
      apply('claude', root, r, {
        owned: ['.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh'],
      }),
    ).rejects.toThrow(/injected/);
    expect(await snapshot(root)).toEqual(before);
    expect((await fs.stat(settings)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(asset)).mode & 0o777).toBe(0o700);
  });
});

describe('files that can hold secrets', () => {
  it('global: a JSON or TOML file palm creates is 0600, whichever kind creates it', async () => {
    const home = await tmpDir();
    await apply('claude', home, await rendered('claude', 'hook', home, 'global'), {});
    expect((await fs.stat(path.join(home, '.claude/settings.json'))).mode & 0o777).toBe(0o600);
    await apply('codex', home, await rendered('codex', 'mcp stdio', home, 'global'));
    expect((await fs.stat(path.join(home, '.codex/config.toml'))).mode & 0o777).toBe(0o600);
  });

  it('a literal secret makes an existing readable file 0600, with a note', async () => {
    const root = await tmpDir();
    await write(path.join(root, '.mcp.json'), '{}\n', 0o644);
    const src = await makeSource();
    const k = allKinds(src).find((e) => e.label === 'mcp stdio')!;
    const target = createTarget('claude', fakeEnv(root));
    const input = renderInput(
      { ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root },
      { secretPolicy: 'literal', secretValues: { GH_TOKEN: 'ghp_secret' } },
    );
    const r = await target.render(input);
    const res = await target.apply({
      rendered: r,
      scopeRoot: root,
      owned: [],
      force: false,
      dryRun: false,
    });
    expect((await fs.stat(path.join(root, '.mcp.json'))).mode & 0o777).toBe(0o600);
    expect(res.notes).toContain(
      '.mcp.json: permissions set to 600 (it now holds a literal secret)',
    );
    expect(await readJson(path.join(root, '.mcp.json'))).toMatchObject({
      mcpServers: { gh: { env: { GH_TOKEN: 'ghp_secret' } } },
    });
  });
});
