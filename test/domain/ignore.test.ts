import { describe, expect, it } from 'vitest';
import {
  ALWAYS_SKIP_DIRS,
  CLOSURE_NEVER,
  COPY_SKIP,
  HASH_SKIP,
  INSTALL_OUTPUT_DIRS,
  isClosureExcluded,
  isDocFile,
  isScanIgnoredRel,
  isTreeExcluded,
  matchesSkip,
  PLUGIN_ROOT_TOKENS,
  PROJECT_DIR_TOKENS,
  SCAN_IGNORE_DIRS,
  shouldSkipDir,
  shouldSkipFile,
} from '../../src/domain/ignore.js';

describe('skip lists', () => {
  it('hash exactly what a copy deploys; every walk skips VCS and dependency dirs', () => {
    expect(HASH_SKIP).toEqual(COPY_SKIP);
    for (const d of ALWAYS_SKIP_DIRS) {
      expect(SCAN_IGNORE_DIRS).toContain(d);
      expect(COPY_SKIP).toContain(d);
    }
  });

  it('the scan ignores the DESIGN rule 0 install outputs and .palm', () => {
    for (const d of [
      '.agents/skills',
      '.claude/skills',
      '.github/skills',
      '.github/agents',
      '.github/instructions',
      '.github/prompts',
      '.cursor/rules',
      '.palm',
    ])
      expect(INSTALL_OUTPUT_DIRS).toContain(d);
    expect(isScanIgnoredRel('.palm/assets/k/h/SKILL.md')).toBe(true);
    expect(isScanIgnoredRel('plugins/x/.claude/skills/y')).toBe(true);
    expect(isScanIgnoredRel('skills/tests/SKILL.md')).toBe(true);
    expect(isScanIgnoredRel('skills/tdd/SKILL.md')).toBe(false);
  });

  it('predicates: exact names, *.ext suffixes and prefix* in any case', () => {
    expect(matchesSkip(COPY_SKIP, 'Bundle.ZIP')).toBe(true);
    expect(matchesSkip(COPY_SKIP, '.git')).toBe(true);
    expect(matchesSkip(COPY_SKIP, '.GIT')).toBe(false);
    expect(shouldSkipDir('templates')).toBe(true);
    expect(shouldSkipFile('templates')).toBe(false);
    expect(isDocFile('README.md')).toBe(true);
  });
});

describe('isClosureExcluded', () => {
  it('never copies skills, root documents, manifests, .git* or node_modules, at any depth', () => {
    expect(CLOSURE_NEVER).toContain('SKILL.md');
    for (const rel of [
      'hooks/SKILL.md',
      'AGENTS.md',
      'scripts/CLAUDE.md',
      '.claude-plugin/plugin.json',
      '.cursor-plugin/x.sh',
      'marketplace.json',
      'hooks/.gitignore',
      'node_modules/a/b.js',
      '.git/config',
    ])
      expect(isClosureExcluded(rel), rel).toBe(true);
    for (const rel of ['hooks/run.sh', 'scripts/x.py', 'workflows/a.yaml', 'hooks/plugin.json.bak'])
      expect(isClosureExcluded(rel), rel).toBe(false);
  });
});

describe('isTreeExcluded', () => {
  it('leaves out copy litter, outputs and root repository files, never entity content', () => {
    for (const rel of [
      '.git',
      'a/node_modules/x',
      'x.zip',
      '.palm/lock',
      '.claude/skills/t/SKILL.md',
      'AGENTS.md',
    ])
      expect(isTreeExcluded(rel), rel).toBe(true);
    for (const rel of [
      'skills/tdd/templates/x.md',
      'skills/tdd/SKILL.md',
      'docs/AGENTS.md',
      'tests/x',
    ])
      expect(isTreeExcluded(rel), rel).toBe(false);
  });
});

describe('relocation tokens', () => {
  const all = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);

  it('PLUGIN_ROOT_TOKENS matches every plugin-root form', () => {
    const text =
      '${CLAUDE_PLUGIN_ROOT}/a $CLAUDE_PLUGIN_ROOT/b ${CLAUDE_PLUGIN_ROOT:-.}/c ${CLAUDE_PLUGIN_ROOT-x}/d ${CURSOR_PLUGIN_ROOT}/e ${PLUGIN_ROOT}/f ${extensionPath}/g $CLAUDE_PLUGIN_ROOTS ${HOME}';
    expect(all(PLUGIN_ROOT_TOKENS, text)).toEqual([
      '${CLAUDE_PLUGIN_ROOT}',
      '$CLAUDE_PLUGIN_ROOT',
      '${CLAUDE_PLUGIN_ROOT:-.}',
      '${CLAUDE_PLUGIN_ROOT-x}',
      '${CURSOR_PLUGIN_ROOT}',
      '${PLUGIN_ROOT}',
      '${extensionPath}',
    ]);
  });

  it('PROJECT_DIR_TOKENS matches the project-dir variables', () => {
    const text =
      '"$CLAUDE_PROJECT_DIR"/a ${CLAUDE_PROJECT_DIR}/b $CURSOR_PROJECT_DIR/c $GEMINI_PROJECT_DIR/d $PROJECT_DIR';
    expect(all(PROJECT_DIR_TOKENS, text)).toEqual([
      '$CLAUDE_PROJECT_DIR',
      '${CLAUDE_PROJECT_DIR}',
      '$CURSOR_PROJECT_DIR',
      '$GEMINI_PROJECT_DIR',
    ]);
  });
});
