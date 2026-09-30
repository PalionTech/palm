import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPLIED_FILE,
  expandHomeDir,
  LOCAL_MANIFEST_FILE,
  LOCK_FILE,
  MANIFEST_FILE,
  palmHomeOf,
  ScopePaths,
  TOKENS,
} from '../../src/domain/scope-paths.js';
import { SourceRef } from '../../src/domain/source.js';
import { cleanupTmp, tmpDir } from '../support/sandbox.js';

afterEach(cleanupTmp);

const PALM_PATHS = { palmHome: '/p', home: '/h', projectRoot: '/proj', cwd: '/proj/sub' };
const kit = new SourceRef({
  name: 'trailofbits/skills',
  type: 'git',
  url: 'https://github.com/trailofbits/skills.git',
});

describe('ScopePaths: files and directories', () => {
  it('project scope: files under the project root, assets and the process lock under .palm', () => {
    const p = ScopePaths.from(PALM_PATHS, 'project', {});
    expect(p.root).toBe('/proj');
    expect(p.manifestFile).toBe(`/proj/${MANIFEST_FILE}`);
    expect(p.lockFile).toBe(`/proj/${LOCK_FILE}`);
    expect(p.localManifestFile).toBe(`/proj/${LOCAL_MANIFEST_FILE}`);
    expect(p.localLockFile).toBe('/proj/.palm/local/lock.yaml');
    expect(p.appliedFile).toBeUndefined();
    expect(p.palmDir).toBe('/proj/.palm');
    expect(p.assetsDir).toBe('/proj/.palm/assets');
    expect(p.processLock).toBe('/proj/.palm/local/lock');
    expect(p.assetRoot(kit, 'gh-cli')).toBe('.palm/assets/trailofbits__skills/gh-cli');
    expect(p.boundaries()).toEqual(['/proj']);
  });

  it('global scope: manifest, lock, assets and applied record under palm home', () => {
    const p = ScopePaths.from(PALM_PATHS, 'global', {});
    expect(p.root).toBe('/h');
    expect(p.manifestFile).toBe('/p/palm.yaml');
    expect(p.lockFile).toBe('/p/palm.lock.yaml');
    expect(p.appliedFile).toBe(`/p/${APPLIED_FILE}`);
    expect(p.processLock).toBe('/p/lock');
    expect(p.assetRoot(kit, 'gh-cli')).toBe('<palm>/assets/trailofbits__skills/gh-cli');
  });

  it('refuses entity names that are not one safe path segment', () => {
    const p = new ScopePaths('project', '/proj', '/p', {});
    for (const bad of ['..', '../x', 'a/b', '', '.hidden'])
      expect(() => p.assetRoot(kit, bad)).toThrowError(
        expect.objectContaining({ code: 'E_USAGE' }),
      );
  });

  it('of(ctx) takes paths and env from the context; at() resolves PALM_HOME against home', () => {
    const env = { CODEX_HOME: '/cx' };
    expect(ScopePaths.of({ paths: PALM_PATHS, env }, 'global').harnessHome('codex')).toBe('/cx');
    expect(ScopePaths.at('global', '/h', {}).palmHome).toBe('/h/.palm');
    expect(ScopePaths.at('global', '/h', { PALM_HOME: '~/alt' }).palmHome).toBe('/h/alt');
    expect(ScopePaths.at('project', '/proj', { HOME: '/u' }).palmHome).toBe('/u/.palm');
  });

  it('harness homes honour the overrides at global scope only', () => {
    const env = {
      CLAUDE_CONFIG_DIR: '/cc',
      CODEX_HOME: '~/cx',
      COPILOT_HOME: 'rel/co',
      GEMINI_CLI_HOME: '/g',
      XDG_CONFIG_HOME: '/xdg',
    };
    const g = ScopePaths.at('global', '/h', env);
    expect(g.harnessHome('claude')).toBe('/cc');
    expect(g.harnessHome('codex')).toBe('/h/cx');
    expect(g.harnessHome('copilot')).toBe('/h/rel/co');
    expect(g.harnessHome('cursor')).toBe('/h/.cursor');
    expect(g.harnessHome('gemini')).toBe('/g/.gemini');
    expect(g.harnessHome('opencode')).toBe('/xdg/opencode');
    expect(ScopePaths.at('global', '/h', {}).harnessHome('opencode')).toBe('/h/.config/opencode');
    const p = ScopePaths.at('project', '/proj', env);
    expect(p.harnessHome('claude')).toBe('/proj/.claude');
  });

  it('global boundaries: home, palm home and every harness home; contains() is strict', () => {
    const g = new ScopePaths('global', '/h', '/p', { CLAUDE_CONFIG_DIR: '/cc' });
    expect(g.boundaries()).toEqual([
      '/h',
      '/p',
      '/cc',
      '/h/.codex',
      '/h/.copilot',
      '/h/.cursor',
      '/h/.gemini',
      '/h/.config/opencode',
    ]);
    expect(g.contains('/cc/agents/a.md')).toBe(true);
    expect(g.contains('/elsewhere/x')).toBe(false);
    expect(g.contains('/cc')).toBe(false);
  });

  it('safeAbs keeps a tampered lock inside the project', () => {
    const p = new ScopePaths('project', '/proj', '/p', {});
    expect(p.safeAbs('.claude/x')).toBe('/proj/.claude/x');
    expect(p.safeAbs('../victim')).toBeUndefined();
    expect(p.safeAbs('.')).toBeUndefined();
  });
});

describe('ScopePaths: lock form and tokens', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cc', GEMINI_CLI_HOME: '/g', XDG_CONFIG_HOME: '/h/xdg' };
  const g = new ScopePaths('global', '/h', '/h/.palm', env);

  it('names the nine tokens', () => {
    expect(TOKENS).toEqual([
      '<home>',
      '<palm>',
      '<agents>',
      '<claude>',
      '<codex>',
      '<copilot>',
      '<cursor>',
      '<gemini>',
      '<opencode>',
    ]);
  });

  it('expands every token and picks the longest match back', () => {
    expect(g.abs('<claude>/skills/x/SKILL.md')).toBe('/cc/skills/x/SKILL.md');
    expect(g.abs('<home>/.claude.json')).toBe('/h/.claude.json');
    expect(g.abs('<palm>/assets/k/h/run.sh')).toBe('/h/.palm/assets/k/h/run.sh');
    expect(g.abs('<agents>/skills/x')).toBe('/h/.agents/skills/x');
    expect(g.abs('<gemini>')).toBe('/g/.gemini');
    expect(g.lockForm('/h/.palm/assets/k/h/run.sh')).toBe('<palm>/assets/k/h/run.sh');
    expect(g.lockForm('/h/xdg/opencode/opencode.json')).toBe('<opencode>/opencode.json');
    expect(g.lockForm('/h/notes.md')).toBe('<home>/notes.md');
    expect(g.lockForm('/cc')).toBe('<claude>');
  });

  it('round-trips lockForm(abs(x)) === x for every token', () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,8}$/)
      .filter((s) => !s.includes('..'));
    const tokens = TOKENS.filter((t) => t !== '<home>');
    fc.assert(
      fc.property(
        fc.constantFrom(...tokens),
        fc.array(segment, { maxLength: 4 }),
        (token, segs) => {
          const x = segs.length ? `${token}/${segs.join('/')}` : token;
          return g.lockForm(g.abs(x)) === x;
        },
      ),
    );
    // <home> paths round-trip unless they fall into a more specific token's directory.
    expect(g.lockForm(g.abs('<home>/dotfiles/x'))).toBe('<home>/dotfiles/x');
  });

  it('refuses unknown tokens, untokenized global paths and absolute lock paths', () => {
    for (const bad of ['<nope>/x', '.claude/x', '/abs/x'])
      expect(() => g.abs(bad), bad).toThrowError(expect.objectContaining({ code: 'E_PARSE' }));
    const p = new ScopePaths('project', '/proj', '/p', {});
    expect(() => p.abs('<claude>/x')).toThrowError(expect.objectContaining({ code: 'E_PARSE' }));
  });

  it('lockForm outside every boundary is E_IO', () => {
    expect(() => g.lockForm('/elsewhere/x')).toThrowError(
      expect.objectContaining({ code: 'E_IO' }),
    );
    const p = new ScopePaths('project', '/proj', '/p', {});
    expect(p.lockForm(path.join('/proj', '.claude', 'x.md'))).toBe('.claude/x.md');
    expect(() => p.lockForm('/proj/../x')).toThrowError(expect.objectContaining({ code: 'E_IO' }));
  });

  it('homes() lists what each token expands to', () => {
    expect(g.homes()).toMatchObject({
      home: '/h',
      palm: '/h/.palm',
      claude: '/cc',
      gemini: '/g/.gemini',
    });
  });
});

describe('ScopePaths.realInside', () => {
  it('follows a symlinked output directory out of the project', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await mkdir(path.join(root, '.cursor'));
    await symlink(outside, path.join(root, '.claude'));
    const p = new ScopePaths('project', root, '/p', {});
    expect((await p.realInside(path.join(root, '.claude/skills/x'))).inside).toBe(false);
    expect((await p.realInside(path.join(root, '.cursor/rules/x.mdc'))).inside).toBe(true);
  });
});

describe('expandHomeDir / palmHomeOf', () => {
  it('expands ~ and resolves relative values against home', () => {
    expect(expandHomeDir(undefined, '/h')).toBeUndefined();
    expect(expandHomeDir('', '/h')).toBeUndefined();
    expect(expandHomeDir('~', '/h')).toBe('/h');
    expect(expandHomeDir('~/x', '/h')).toBe('/h/x');
    expect(expandHomeDir('x/y', '/h')).toBe('/h/x/y');
    expect(expandHomeDir('/abs', '/h')).toBe('/abs');
    expect(palmHomeOf({}, '/h')).toBe('/h/.palm');
    expect(palmHomeOf({ PALM_HOME: '~/.p' }, '/h')).toBe('/h/.p');
  });
});
