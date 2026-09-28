import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expandHomeDir,
  LOCK_FILE,
  MANIFEST_FILE,
  palmHomeOf,
  ScopePaths,
} from '../../src/domain/scope-paths.js';

const PALM_PATHS = { palmHome: '/p', home: '/h', projectRoot: '/proj', cwd: '/proj/sub' };

describe('ScopePaths', () => {
  it('project scope: files under the project root, hook assets under .palm', () => {
    const p = ScopePaths.from(PALM_PATHS, 'project', {});
    expect(p.root).toBe('/proj');
    expect(p.manifestFile).toBe(`/proj/${MANIFEST_FILE}`);
    expect(p.lockFile).toBe(`/proj/${LOCK_FILE}`);
    expect(p.palmDir).toBe('/proj/.palm');
    expect(p.hooksDir).toBe('/proj/.palm/hooks');
    expect(p.hooksAssetDir('fmt')).toBe('/proj/.palm/hooks/fmt');
    expect(p.boundaries()).toEqual(['/proj']);
  });

  it('global scope: manifest, lock and hook assets under palm home', () => {
    const p = ScopePaths.from(PALM_PATHS, 'global', {});
    expect(p.root).toBe('/h');
    expect(p.manifestFile).toBe('/p/palm.yaml');
    expect(p.lockFile).toBe('/p/palm.lock.yaml');
    expect(p.hooksAssetDir('fmt')).toBe('/p/hooks/fmt');
    expect(p.boundaries()).toEqual(['/h', '/p']);
  });

  it('of(ctx) takes paths and env from the context', () => {
    const env = { CODEX_HOME: '/cx' };
    const p = ScopePaths.of({ paths: PALM_PATHS, env }, 'global');
    expect(p.env).toBe(env);
    expect(p.harnessHome('codex')).toBe('/cx');
  });

  it('at(): global root is the home, PALM_HOME resolves against it', () => {
    expect(ScopePaths.at('global', '/h', {}).palmHome).toBe('/h/.palm');
    expect(ScopePaths.at('global', '/h', { PALM_HOME: '~/alt' }).palmHome).toBe('/h/alt');
    expect(ScopePaths.at('global', '/h', { PALM_HOME: '/abs' }).palmHome).toBe('/abs');
    expect(ScopePaths.at('project', '/proj', { HOME: '/u' }).palmHome).toBe('/u/.palm');
  });

  it('harness homes honour CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME at global scope only', () => {
    const env = { CLAUDE_CONFIG_DIR: '/cc', CODEX_HOME: '~/cx', COPILOT_HOME: 'rel/co' };
    const g = ScopePaths.at('global', '/h', env);
    expect(g.harnessHome('claude')).toBe('/cc');
    expect(g.harnessHome('codex')).toBe('/h/cx');
    expect(g.harnessHome('copilot')).toBe('/h/rel/co');
    expect(g.harnessHome('cursor')).toBe('/h/.cursor');
    const p = ScopePaths.at('project', '/proj', env);
    expect(p.harnessHome('claude')).toBe('/proj/.claude');
    expect(p.harnessHome('codex')).toBe('/proj/.codex');
    expect(ScopePaths.at('global', '/h', {}).harnessHome('claude')).toBe('/h/.claude');
  });

  it('global boundaries include palm home and every harness override', () => {
    const env = { CLAUDE_CONFIG_DIR: '/cc', CODEX_HOME: '~/cx', COPILOT_HOME: '' };
    const g = new ScopePaths('global', '/h', '/p', env);
    expect(g.boundaries()).toEqual(['/h', '/p', '/cc', '/h/cx']);
    expect(g.contains('/cc/agents/a.md')).toBe(true);
    expect(g.contains('/p/hooks/x')).toBe(true);
    expect(g.contains('/elsewhere/x')).toBe(false);
    // boundaries themselves are never inside
    expect(g.contains('/cc')).toBe(false);
    expect(g.contains('/h')).toBe(false);
  });

  it('contains() keeps a project scope inside its root', () => {
    const p = new ScopePaths('project', '/proj', '/p', {});
    expect(p.contains('/proj/.claude/x')).toBe(true);
    expect(p.contains('/proj/../victim')).toBe(false);
    expect(p.contains('/p/hooks/x')).toBe(false);
    expect(p.safeAbs('.claude/x')).toBe('/proj/.claude/x');
    expect(p.safeAbs('../victim')).toBeUndefined();
    expect(p.safeAbs('/etc/passwd')).toBeUndefined();
    expect(p.safeAbs('.')).toBeUndefined();
  });

  it('lockForm and abs round-trip: posix-relative at project scope, absolute at global', () => {
    const p = new ScopePaths('project', '/proj', '/p', {});
    const abs = path.join('/proj', '.claude', 'skills', 'demo', 'SKILL.md');
    expect(p.lockForm(abs)).toBe('.claude/skills/demo/SKILL.md');
    expect(p.abs(p.lockForm(abs))).toBe(abs);
    const g = new ScopePaths('global', '/h', '/p', {});
    expect(g.lockForm('/h/.claude/x.md')).toBe('/h/.claude/x.md');
    expect(g.abs(g.lockForm('/cc/x.md'))).toBe('/cc/x.md');
    expect(g.abs('.claude/x.md')).toBe('/h/.claude/x.md');
  });

  it('refuses unsafe hook asset names', () => {
    const p = new ScopePaths('project', '/proj', '/p', {});
    for (const bad of ['..', '../x', 'a/b', '', '.hidden'])
      expect(() => p.hooksAssetDir(bad)).toThrowError(expect.objectContaining({ code: 'E_USAGE' }));
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
