import { describe, expect, it } from 'vitest';
import {
  ALWAYS_SKIP_DIRS,
  COPY_SKIP,
  DOC_FILE_NAMES,
  HASH_SKIP,
  HOOK_ASSET_SKIP_FILE,
  HOOK_ASSET_SKIP_TOP,
  INSTALL_OUTPUT_DIRS,
  isDocFile,
  isScanIgnoredRel,
  matchesSkip,
  ROOT_IGNORED_FILES,
  SCAN_IGNORE_DIRS,
  shouldSkipDir,
  shouldSkipFile,
} from '../../src/domain/ignore.js';

/** The lists as they stood in each consumer before they moved here (wave 2D). */
const FORMER = {
  /** src/index/ignore.ts IGNORED_DIR_NAMES */
  scanDirs: [
    'node_modules',
    '.git',
    'test',
    'tests',
    'fixture',
    'fixtures',
    'eval',
    'evals',
    'example',
    'examples',
    'template',
    'templates',
    'docs',
    'website',
    'dist',
    'build',
  ],
  /** src/index/ignore.ts minimalIgnoreGlobs */
  minimalScanDirs: ['.git', 'node_modules'],
  /** src/index/ignore.ts INSTALL_OUTPUT_DIRS */
  installOutputs: [
    '.agents/skills',
    '.claude/skills',
    '.claude/agents',
    '.claude/commands',
    '.claude/rules',
    '.github/skills',
    '.github/agents',
    '.github/instructions',
    '.github/prompts',
    '.github/hooks',
    '.cursor/rules',
    '.cursor/agents',
    '.cursor/commands',
    '.codex/agents',
    '.codex/prompts',
    '.vscode',
  ],
  /** src/index/ignore.ts ROOT_IGNORED_FILES */
  rootFiles: [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.mcp.json.example',
    '.cursor/mcp.json',
    '.cursor/hooks.json',
  ],
  /** src/index/util.ts DOC_NAMES */
  docNames: [
    'readme.md',
    'changelog.md',
    'license.md',
    'contributing.md',
    'code_of_conduct.md',
    'security.md',
    'agents.md',
    'claude.md',
    'gemini.md',
  ],
  /** src/targets/fs-utils.ts ALWAYS_SKIP plus its `*.zip` check */
  copy: ['.git', 'node_modules', '.DS_Store', '*.zip'],
  /** src/core/hash.ts (`.git` only) */
  hash: ['.git'],
  /** src/targets/base.ts HOOK_ASSET_SKIP_TOP */
  hookTop: [
    '.github',
    '.gitlab',
    '.vscode',
    '.idea',
    'docs',
    'doc',
    'website',
    'site',
    'test',
    'tests',
    '__tests__',
    'spec',
    'fixtures',
    'examples',
    'example',
    'evals',
    'assets',
    'media',
    'images',
    'screenshots',
  ],
};

describe('consolidated skip lists are supersets of every former list', () => {
  it.each([
    ['SCAN_IGNORE_DIRS', SCAN_IGNORE_DIRS, FORMER.scanDirs],
    ['ALWAYS_SKIP_DIRS', ALWAYS_SKIP_DIRS, FORMER.minimalScanDirs],
    ['INSTALL_OUTPUT_DIRS', INSTALL_OUTPUT_DIRS, FORMER.installOutputs],
    ['ROOT_IGNORED_FILES', ROOT_IGNORED_FILES, FORMER.rootFiles],
    ['DOC_FILE_NAMES', DOC_FILE_NAMES, FORMER.docNames],
    ['COPY_SKIP', COPY_SKIP, FORMER.copy],
    ['HASH_SKIP', HASH_SKIP, FORMER.hash],
    ['HOOK_ASSET_SKIP_TOP', HOOK_ASSET_SKIP_TOP, FORMER.hookTop],
  ])('%s', (_name, now, before) => {
    expect(now).toEqual(expect.arrayContaining(before));
  });

  it('only the hash list grew: it now equals the copy list (hash what is deployed)', () => {
    const grown = (now: readonly string[], before: string[]) =>
      now.filter((x) => !before.includes(x));
    expect(grown(SCAN_IGNORE_DIRS, FORMER.scanDirs)).toEqual([]);
    expect(grown(ALWAYS_SKIP_DIRS, FORMER.minimalScanDirs)).toEqual([]);
    expect(grown(COPY_SKIP, FORMER.copy)).toEqual([]);
    expect(grown(HOOK_ASSET_SKIP_TOP, FORMER.hookTop)).toEqual([]);
    expect(grown(HASH_SKIP, FORMER.hash)).toEqual(['node_modules', '.DS_Store', '*.zip']);
    expect(HASH_SKIP).toEqual(COPY_SKIP);
  });

  it('the walk-level lists share the VCS/dependency dirs', () => {
    for (const d of ALWAYS_SKIP_DIRS) {
      expect(SCAN_IGNORE_DIRS).toContain(d);
      expect(COPY_SKIP).toContain(d);
    }
  });
});

describe('predicates', () => {
  it('matchesSkip: exact names, and *.ext suffixes in any case', () => {
    expect(matchesSkip(COPY_SKIP, '.git')).toBe(true);
    expect(matchesSkip(COPY_SKIP, 'bundle.zip')).toBe(true);
    expect(matchesSkip(COPY_SKIP, 'BUNDLE.ZIP')).toBe(true);
    expect(matchesSkip(COPY_SKIP, 'zip')).toBe(false);
    expect(matchesSkip(COPY_SKIP, '.GIT')).toBe(false);
    expect(matchesSkip(COPY_SKIP, 'SKILL.md')).toBe(false);
  });

  it('shouldSkipDir is the scan rule, shouldSkipFile the copy/hash rule', () => {
    expect(shouldSkipDir('fixtures')).toBe(true);
    expect(shouldSkipDir('node_modules')).toBe(true);
    expect(shouldSkipDir('skills')).toBe(false);
    for (const name of ['.git', 'node_modules', '.DS_Store', 'x.zip']) {
      expect(shouldSkipFile(name)).toBe(true);
    }
    expect(shouldSkipFile('fixtures')).toBe(false);
    expect(shouldSkipFile('run.sh')).toBe(false);
  });

  it('isDocFile ignores case', () => {
    expect(isDocFile('README.md')).toBe(true);
    expect(isDocFile('Claude.md')).toBe(true);
    expect(isDocFile('reviewer.md')).toBe(false);
  });

  it('isScanIgnoredRel: an ignored segment anywhere, or a path under an install output', () => {
    expect(isScanIgnoredRel('a/tests/b.md')).toBe(true);
    expect(isScanIgnoredRel('pkg/.claude/skills/x')).toBe(true);
    expect(isScanIgnoredRel('.vscode')).toBe(true);
    expect(isScanIgnoredRel('.claude/skillset/x')).toBe(false);
    expect(isScanIgnoredRel('skills/testing/SKILL.md')).toBe(false);
  });

  it('HOOK_ASSET_SKIP_FILE matches repository documents only', () => {
    expect(HOOK_ASSET_SKIP_FILE.test('README.md')).toBe(true);
    expect(HOOK_ASSET_SKIP_FILE.test('release-notes.txt')).toBe(true);
    expect(HOOK_ASSET_SKIP_FILE.test('run.sh')).toBe(false);
  });
});
