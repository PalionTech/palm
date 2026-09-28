/**
 * `writeFileAtomic` writes through symlinks (PLAN §2 item 7): a dotfiles-managed
 * `~/.claude/settings.json`, `~/.codex/config.toml` or a symlinked `palm.lock.yaml` keeps being
 * a link after palm rewrites it, and the temp file never lands next to the link.
 */
import { lstat, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeJsonFile } from '../../src/lib/fs.js';
import { writeYamlFile } from '../../src/lib/yaml.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

const isLink = async (p: string) => (await lstat(p)).isSymbolicLink();

describe('writeFileAtomic through symlinks', () => {
  it('keeps a symlinked file a link and writes its target (absolute link)', async () => {
    const root = await tmpDir();
    const dotfiles = join(root, 'dotfiles');
    const real = join(dotfiles, 'claude-settings.json');
    await write(real, '{"theme":"light"}\n', 0o640);
    const home = join(root, 'home', '.claude');
    await mkdir(home, { recursive: true });
    const link = join(home, 'settings.json');
    await symlink(real, link);

    await writeJsonFile(link, { theme: 'dark' });

    expect(await isLink(link)).toBe(true);
    expect(await readlink(link)).toBe(real);
    expect(await read(real)).toBe('{\n  "theme": "dark"\n}\n');
    expect((await stat(real)).mode & 0o777).toBe(0o640);
    // No temp file left in either directory.
    expect(await readdir(home)).toEqual(['settings.json']);
    expect(await readdir(dotfiles)).toEqual(['claude-settings.json']);
  });

  it('follows relative links and chains, resolving each against the real directory', async () => {
    const root = await tmpDir();
    await write(join(root, 'store', 'config.toml'), 'model = "a"\n');
    await mkdir(join(root, 'codex'));
    // codex/config.toml -> ../mid/config.toml -> ../store/config.toml
    await mkdir(join(root, 'mid'));
    await symlink('../store/config.toml', join(root, 'mid', 'config.toml'));
    await symlink('../mid/config.toml', join(root, 'codex', 'config.toml'));
    // Reach the link through a symlinked parent directory as well.
    await symlink(join(root, 'codex'), join(root, 'codex-home'));

    await writeFileAtomic(join(root, 'codex-home', 'config.toml'), 'model = "b"\n');

    expect(await isLink(join(root, 'codex', 'config.toml'))).toBe(true);
    expect(await isLink(join(root, 'mid', 'config.toml'))).toBe(true);
    expect(await read(join(root, 'store', 'config.toml'))).toBe('model = "b"\n');
    expect(await readdir(join(root, 'codex'))).toEqual(['config.toml']);
  });

  it('writes into a symlinked parent directory without replacing the directory link', async () => {
    const root = await tmpDir();
    const realDir = join(root, 'dotfiles', 'claude');
    await write(join(realDir, 'settings.json'), '{}\n');
    const linkDir = join(root, '.claude');
    await symlink(realDir, linkDir);

    await writeFileAtomic(join(linkDir, 'settings.json'), '{"a":1}\n');
    await writeFileAtomic(join(linkDir, 'agents', 'x.md'), 'agent\n');

    expect(await isLink(linkDir)).toBe(true);
    expect(await read(join(realDir, 'settings.json'))).toBe('{"a":1}\n');
    expect(await read(join(realDir, 'agents', 'x.md'))).toBe('agent\n');
  });

  it('creates the missing target of a dangling link and keeps the link', async () => {
    const root = await tmpDir();
    const target = join(root, 'dotfiles', 'new', 'palm.lock.yaml');
    const link = join(root, 'project', 'palm.lock.yaml');
    await mkdir(join(root, 'project'), { recursive: true });
    await symlink(target, link);

    await writeYamlFile(link, { version: 2, entries: [] });

    expect(await isLink(link)).toBe(true);
    expect(await read(target)).toContain('version: 2');
  });

  it('refuses a link loop with ELOOP', async () => {
    const root = await tmpDir();
    await symlink(join(root, 'b'), join(root, 'a'));
    await symlink(join(root, 'a'), join(root, 'b'));
    await expect(writeFileAtomic(join(root, 'a'), 'x')).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
