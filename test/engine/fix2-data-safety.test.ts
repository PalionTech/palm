/**
 * Data-safety rulings from the second persona rerun (FINDINGS-v3.md), end to end through the
 * built CLI with real git: LF renders and hashes under `* text=auto eol=lf` (O1), no delete
 * through a per-skill symlink into another target's output (T1), and two installs started
 * together keep both entries (B1).
 */
import { lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, Machine } from '../cli/world.js';

let m: Machine;

beforeEach(async () => {
  m = await Machine.create();
});

afterEach(async () => {
  await m.dispose();
});

const CRLF_SKILL =
  '---\r\nname: crlf\r\ndescription: A skill written on Windows\r\n---\r\n\r\nLine one.\r\nLine two.\r\n';

async function commitAll(dir: string): Promise<void> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'palm');
}

describe('O1 LF-normalised text renders and hashes', () => {
  it('O1 a CRLF source under `* text=auto eol=lf` stays clean in a fresh clone', async () => {
    const url = await m.source('win', { 'v1.0.0': { 'skills/crlf/SKILL.md': CRLF_SKILL } });
    const p = await m.project('app');
    await writeFile(join(p, '.gitattributes'), '* text=auto eol=lf\n');
    const first = await m.palm(p, 'install', url, 'crlf');
    expect(first.code, first.all).toBe(0);
    const written = await readFile(join(p, '.claude/skills/crlf/SKILL.md'), 'utf8');
    expect(written).not.toContain('\r');
    expect(written).toContain('Line one.\nLine two.\n');
    await commitAll(p);
    expect(await git(p, 'status', '--porcelain')).toBe('');

    const clone = join(m.root, 'clone');
    await git(m.root, 'clone', '-q', p, clone);
    const check = await m.palm(clone, 'check', '--allow-local-sources');
    expect(check.code, check.all).toBe(0);
    // S4: a file:// source outside the clone is typed, never taken from palm.yaml alone.
    const bare = await m.palm(clone, 'install', url, 'crlf');
    expect(bare.code, bare.all).toBe(0);
    expect(bare.all).not.toMatch(/modified|changed since palm wrote/);
    expect(await git(clone, 'status', '--porcelain')).toBe('');

    const forced = await m.palm(p, 'install', url, 'crlf', '--force');
    expect(forced.code, forced.all).toBe(0);
    expect(await git(p, 'status', '--porcelain')).toBe('');
  });

  it('O1 a CRLF working copy of an LF render is the same file (core.autocrlf)', async () => {
    const skill = '---\nname: lf\ndescription: An LF skill\n---\n\nLine one.\nLine two.\n';
    const url = await m.source('lf', { 'v1.0.0': { 'skills/lf/SKILL.md': skill } });
    const p = await m.project('app');
    const first = await m.palm(p, 'install', url, 'lf');
    expect(first.code, first.all).toBe(0);
    const file = join(p, '.claude/skills/lf/SKILL.md');
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\n', '\r\n'));
    const check = await m.palm(p, 'check', '--allow-local-sources');
    expect(check.code, check.all).toBe(0);
    const bare = await m.palm(p, 'install', url, 'lf');
    expect(bare.code, bare.all).toBe(0);
    expect(bare.all).not.toMatch(/modified|changed since palm wrote/);
  });
});

describe('T1 no delete through a link into another target', () => {
  const KIT = {
    'skills/fmt/SKILL.md': '---\nname: fmt\ndescription: Formats code\n---\n\nFormat it.\n',
    'skills/fmt/agents/openai.yaml': 'interface:\n  display_name: Fmt\n',
  };

  it('T1 per-skill symlinks: install --force and narrowing targets keep the Codex-only file', async () => {
    const url = await m.source('kit', { 'v1.0.0': KIT });
    const p = await m.project('app', ['.claude', '.codex']);
    await writeFile(join(p, 'palm.yaml'), 'targets: [claude, codex]\n');
    const first = await m.palm(p, 'install', url, 'fmt');
    expect(first.code, first.all).toBe(0);
    const codexOnly = join(p, '.agents/skills/fmt/agents/openai.yaml');
    const codexText = await readFile(codexOnly, 'utf8');

    await rm(join(p, '.claude/skills/fmt'), { recursive: true });
    await symlink('../../.agents/skills/fmt', join(p, '.claude/skills/fmt'));
    const forced = await m.palm(p, 'install', url, 'fmt', '--force');
    expect(forced.code, forced.all).toBe(0);
    expect(await readFile(codexOnly, 'utf8')).toBe(codexText);
    expect((await lstat(join(p, '.claude/skills/fmt'))).isSymbolicLink()).toBe(true);

    const check = await m.palm(p, 'check', '--allow-local-sources');
    expect(check.all).toContain('no stray file in a folder palm owns');
    expect(check.all).not.toContain('does not list');

    const yaml = await readFile(join(p, 'palm.yaml'), 'utf8');
    await writeFile(
      join(p, 'palm.yaml'),
      yaml.replace('targets: [claude, codex]', 'targets: [codex]'),
    );
    const narrowed = await m.palm(p, 'install', url, 'fmt');
    expect(narrowed.code, narrowed.all).toBe(0);
    expect(await readFile(codexOnly, 'utf8')).toBe(codexText);
    expect(await readFile(join(p, '.agents/skills/fmt/SKILL.md'), 'utf8')).toContain('Format it.');
  });
});

describe('B1 two installs started together', () => {
  it('B1 the second process waits for the first; neither entry is lost', async () => {
    const skills: Record<string, string> = {};
    const names = ['alpha', 'bravo', 'charlie', 'delta'];
    for (const n of names)
      skills[`skills/${n}/SKILL.md`] = `---\nname: ${n}\ndescription: Skill ${n}\n---\n\n${n}\n`;
    const url = await m.source('many', { 'v1.0.0': skills });
    const p = await m.project('app');
    const seed = await m.palm(p, 'install', url, 'alpha');
    expect(seed.code, seed.all).toBe(0);
    const runs = await Promise.all(names.slice(1).map((n) => m.palm(p, 'install', url, n)));
    for (const r of runs) expect(r.code, r.all).toBe(0);
    const manifest = await readFile(join(p, 'palm.yaml'), 'utf8');
    const lock = await readFile(join(p, 'palm.lock.yaml'), 'utf8');
    for (const n of names) {
      expect(lock).toContain(`name: ${n}`);
      expect(await readFile(join(p, `.claude/skills/${n}/SKILL.md`), 'utf8')).toContain(n);
    }
    expect(manifest).toContain('many');
    const check = await m.palm(p, 'check', '--allow-local-sources');
    expect(check.code, check.all).toBe(0);
  });
});

/** 24 distinct characters; a value built from them at runtime looks random to the scanner. */
const RANDOM = 'Zx8kQ2mN7pL4vR9tW3yB6cF1';

describe("Y15' a policy change re-renders every target", () => {
  it("Y15' --secrets env-ref after literal rewrites the literal in every harness file", async () => {
    const p = await m.project('app', ['.claude', '.opencode']);
    await writeFile(join(p, 'palm.yaml'), 'targets: [claude, opencode]\n');
    const value = RANDOM;
    const base = ['install', 'mcp', 'docs', '--url', 'https://docs.example/mcp'];
    const lit = await m.palm(p, ...base, '--header', `X-Api-Key=${value}`, '--secrets', 'literal');
    expect(lit.code, lit.all).toBe(0);
    const files = ['.mcp.json', 'opencode.json'];
    for (const f of files) expect(await readFile(join(p, f), 'utf8')).toContain(value);
    await commitAll(p);
    const ref = ['--header', 'X-Api-Key=${DOCS_API_KEY}', '--secrets', 'env-ref', '--force'];
    const back = await m.palm(p, ...base, ...ref);
    expect(back.code, back.all).toBe(0);
    expect(back.all).not.toContain('modified');
    for (const f of files) {
      const text = await readFile(join(p, f), 'utf8');
      expect(text, f).not.toContain(value);
      expect(text, f).toContain('DOCS_API_KEY');
    }
    const check = await m.palm(p, 'check');
    expect(check.all).not.toContain('renders differently');
  });

  it("Y15' dropping secrets: literal from palm.yaml re-renders every target on a bare install", async () => {
    const p = await m.project('app', ['.claude', '.opencode']);
    await writeFile(join(p, 'palm.yaml'), 'targets: [claude, opencode]\n');
    const value = RANDOM;
    const base = ['install', 'mcp', 'docs', '--url', 'https://docs.example/mcp'];
    const lit = await m.palm(p, ...base, '--header', `X-Api-Key=${value}`, '--secrets', 'literal');
    expect(lit.code, lit.all).toBe(0);
    await commitAll(p);
    const yaml = await readFile(join(p, 'palm.yaml'), 'utf8');
    expect(yaml).toContain('    secrets: literal\n');
    await writeFile(join(p, 'palm.yaml'), yaml.replace('    secrets: literal\n', ''));
    const bare = await m.palm(p, 'install');
    expect(bare.code, bare.all).toBe(0);
    expect(bare.all).not.toContain('modified');
    for (const f of ['.mcp.json', 'opencode.json']) {
      const text = await readFile(join(p, f), 'utf8');
      expect(text, f).not.toContain(value);
      expect(text, f).toContain('DOCS_API_KEY');
    }
  });
});

describe("Y1' one renderer path for typed and bare installs", () => {
  it("Y1' a bare install after install mcp leaves OpenCode's file as it is; check passes", async () => {
    const p = await m.project('app', ['.claude', '.opencode']);
    await writeFile(join(p, 'palm.yaml'), 'targets: [claude, opencode]\n');
    const add = await m.palm(
      p,
      'install',
      'mcp',
      'docs',
      '--url',
      'https://docs.example/mcp',
      '--header',
      `X-Api-Key=${RANDOM}`,
    );
    expect(add.code, add.all).toBe(0);
    const typed = await readFile(join(p, 'opencode.json'), 'utf8');
    const bare = await m.palm(p, 'install');
    expect(bare.code, bare.all).toBe(0);
    expect(await readFile(join(p, 'opencode.json'), 'utf8')).toBe(typed);
    const check = await m.palm(p, 'check');
    expect(check.all).not.toContain('renders differently');
    expect(check.all).not.toMatch(/generated files? differs? from the lock/);
  });
});

describe('S4 a file:// URL outside the project', () => {
  const KIT = {
    'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lints code\n---\n\nLint it.\n',
  };

  it('S4 palm.yaml alone cannot install from it; typed on the command line it installs', async () => {
    const url = await m.source('private', { 'v1.0.0': KIT });
    const p = await m.project('app');
    await writeFile(
      join(p, 'palm.yaml'),
      `targets: [claude]\nsources:\n  private:\n    url: ${url}\n    skills: [lint]\n`,
    );
    const bare = await m.palm(p, 'install');
    expect(bare.code).not.toBe(0);
    expect(bare.all).toContain(`source "private" is ${url}, outside the project`);
    expect(bare.all).toContain('palm install --allow-local-sources');
    await expect(readFile(join(p, '.claude/skills/lint/SKILL.md'), 'utf8')).rejects.toThrow();
    const typed = await m.palm(p, 'install', url, 'lint');
    expect(typed.code, typed.all).toBe(0);
    expect(await readFile(join(p, '.claude/skills/lint/SKILL.md'), 'utf8')).toContain('Lint it.');
  });

  it('S4 the lock records the URL relative to the project, never as an absolute path', async () => {
    const url = await m.source('kit', { 'v1.0.0': KIT });
    const p = await m.project('app');
    expect((await m.palm(p, 'install', url, 'lint')).code).toBe(0);
    const lock = await readFile(join(p, 'palm.lock.yaml'), 'utf8');
    expect(lock).toContain('url: file:../remotes/kit.git');
    expect(lock).not.toContain('file:///');
    const again = await m.palm(p, 'install', url, 'lint');
    expect(again.code, again.all).toBe(0);
    expect(again.all).not.toContain('fetch');
  });
});
