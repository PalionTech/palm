/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on the targets side: one test per
 * ruling id.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entity, TargetId } from '../../src/core/types.js';
import { createTarget } from '../../src/targets/index.js';
import { sameContent } from '../../src/targets/same-content.js';
import { withSkillName } from '../../src/targets/skill-name.js';
import { cleanupTmp, fakeEnv, install, mkEntity, read, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const skillEntity = (name: string, entityPath = `skills/${name}`): Entity =>
  mkEntity({ kind: 'skill', skill: { name, description: `${name} skill` } }, name, entityPath);

/** skills.sh `computeSkillFolderHash`: files sorted by path, each path then its bytes. */
async function skillsShHash(dir: string): Promise<string> {
  const files: Array<{ rel: string; buf: Buffer }> = [];
  const collect = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await collect(p);
      else
        files.push({
          rel: path.relative(dir, p).split(path.sep).join('/'),
          buf: await fs.readFile(p),
        });
    }
  };
  await collect(dir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update(f.buf);
  }
  return h.digest('hex');
}

const named = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;

/** Five skills shaped like the skills.sh-locked ones in Chris's repository. */
const PARITY_SKILLS: Record<string, Record<string, string>> = {
  'vercel-react-best-practices': {
    'SKILL.md': `${named('vercel-react-best-practices')}\nFor the complete guide: \`AGENTS.md\`\n`,
    'AGENTS.md': '# React best practices\n\nEvery rule expanded.\n',
    'README.md': '# readme\n',
    'metadata.json': '{"version":"1.0.0"}\n',
    'rules/async-parallel.md': '# parallel\n',
  },
  'vercel-react-native-skills': {
    'SKILL.md': `${named('vercel-react-native-skills')}\nFor the complete guide: \`AGENTS.md\`\n`,
    'AGENTS.md': '# React Native\n',
    'README.md': '# readme\n',
    'rules/lists.md': '# lists\n',
  },
  'migrate-to-static-config': {
    'SKILL.md': named('migrate-to-static-config'),
    'agents/openai.yaml': 'interface:\n  display_name: Migrate\n',
    'references/static.md': '# static\n',
  },
  'upgrade-react-navigation': {
    'SKILL.md': named('upgrade-react-navigation'),
    'agents/openai.yaml': 'interface:\n  display_name: Upgrade\n',
    'CLAUDE.md': '# notes for Claude\n',
  },
  'react-native-best-practices': {
    'SKILL.md': named('react-native-best-practices'),
    'GEMINI.md': '# notes for Gemini\n',
    'references/svg/SKILL.md': named('svg'),
    'references/svg/AGENTS.md': '# svg rules\n',
  },
};

async function paritySource(): Promise<string> {
  const root = await tmpDir('palm-source-');
  for (const [skill, files] of Object.entries(PARITY_SKILLS))
    for (const [rel, text] of Object.entries(files))
      await write(path.join(root, 'skills', skill, rel), text);
  return root;
}

async function installSkill(id: TargetId, c: { root: string; src: string; name: string }) {
  const entity = skillEntity(c.name);
  const targets: TargetId[] = ['claude', 'codex'];
  return install(createTarget(id, fakeEnv(c.root)), {
    entity,
    absPath: path.join(c.src, 'skills', c.name),
    scope: 'project',
    scopeRoot: c.root,
    sourceRoot: c.src,
    targets,
  });
}

describe('X1 a skill’s own AGENTS.md, CLAUDE.md and GEMINI.md are skill content', () => {
  it('X1 skills.sh hash parity is 5/5 in .agents/skills', async () => {
    const src = await paritySource();
    const root = await tmpDir();
    const matches: string[] = [];
    for (const name of Object.keys(PARITY_SKILLS)) {
      const { rendered } = await installSkill('codex', { root, src, name });
      expect(rendered.notes.join('\n')).not.toContain('left out');
      const got = await skillsShHash(path.join(root, '.agents/skills', name));
      if (got === (await skillsShHash(path.join(src, 'skills', name)))) matches.push(name);
    }
    expect(matches).toHaveLength(5);
  });

  it('X1 the Claude copy keeps AGENTS.md; only agents/openai.yaml stays out of .claude/skills', async () => {
    const src = await paritySource();
    const root = await tmpDir();
    await installSkill('claude', { root, src, name: 'vercel-react-best-practices' });
    const dir = path.join(root, '.claude/skills/vercel-react-best-practices');
    expect(await read(path.join(dir, 'AGENTS.md'))).toBe(
      '# React best practices\n\nEvery rule expanded.\n',
    );
    await installSkill('claude', { root, src, name: 'upgrade-react-navigation' });
    const other = path.join(root, '.claude/skills/upgrade-react-navigation');
    expect(await read(path.join(other, 'CLAUDE.md'))).toBe('# notes for Claude\n');
    await expect(fs.stat(path.join(other, 'agents/openai.yaml'))).rejects.toThrow();
  });

  it('X1 harness directories, palm files, .git, node_modules and .env stay out', async () => {
    const src = await tmpDir('palm-source-');
    const dir = path.join(src, 'skills/kit');
    await write(path.join(dir, 'SKILL.md'), named('kit'));
    for (const rel of ['.claude/settings.json', '.cursor/rules/a.mdc', '.github/x.yml', '.env'])
      await write(path.join(dir, rel), 'x\n');
    for (const rel of ['palm.yaml', '.palm/assets/a.sh', 'node_modules/a/b.js'])
      await write(path.join(dir, rel), 'x\n');
    for (const rel of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json'])
      await write(path.join(dir, rel), '{}\n');
    const root = await tmpDir();
    const { rendered } = await installSkill('claude', { root, src, name: 'kit' });
    expect(rendered.files.map((f) => f.path)).toEqual([
      '.claude/skills/kit/.mcp.json',
      '.claude/skills/kit/AGENTS.md',
      '.claude/skills/kit/CLAUDE.md',
      '.claude/skills/kit/GEMINI.md',
      '.claude/skills/kit/SKILL.md',
    ]);
    expect(rendered.notes).toContain(
      'skill kit: left out .claude, .cursor, .env +3 (harness, palm and .env files are not skill content)',
    );
  });
});

describe('T2 tests and fixtures stay in the source', () => {
  it('T2 tests/, test/, fixtures/, __tests__/ and *.test.* are not copied, with one note', async () => {
    const src = await tmpDir('palm-source-');
    const dir = path.join(src, 'skills/autoreview');
    await write(path.join(dir, 'SKILL.md'), named('autoreview'));
    await write(path.join(dir, 'scripts/review.py'), 'print(1)\n');
    await write(path.join(dir, 'lib/check.ts'), 'export {}\n');
    for (const rel of [
      'tests/fixtures/sensitive.ts',
      'test/a.py',
      'fixtures/b.json',
      'lib/__tests__/c.ts',
      'lib/check.test.ts',
    ])
      await write(path.join(dir, rel), 'x\n');
    const root = await tmpDir();
    const { rendered } = await installSkill('claude', { root, src, name: 'autoreview' });
    expect(rendered.files.map((f) => f.path)).toEqual([
      '.claude/skills/autoreview/SKILL.md',
      '.claude/skills/autoreview/lib/check.ts',
      '.claude/skills/autoreview/scripts/review.py',
    ]);
    expect(rendered.notes).toContain(
      'skill autoreview: left out fixtures, lib/__tests__, lib/check.test.ts +2 (tests and fixtures stay in the source)',
    );
  });
});

describe('T5 the rendered SKILL.md names its skill', () => {
  it('T5 name: is added after the opening fence when the frontmatter lacks it', async () => {
    const src = await tmpDir('palm-source-');
    const body = '---\ndescription: "Skill: task"\n---\n\n# Task\n';
    await write(path.join(src, 'skills/task/SKILL.md'), body);
    const root = await tmpDir();
    await installSkill('codex', { root, src, name: 'task' });
    expect(await read(path.join(root, '.agents/skills/task/SKILL.md'))).toBe(
      '---\nname: task\ndescription: "Skill: task"\n---\n\n# Task\n',
    );
  });

  it('T5 a SKILL.md that names itself is copied byte for byte', () => {
    const text = Buffer.from('---\r\nname: other\r\ndescription: d\r\n---\r\nbody\r\n');
    expect(Buffer.from(withSkillName(text, 'task')).equals(text)).toBe(true);
  });

  it('T5 CRLF, a BOM and a file without frontmatter keep their shape', () => {
    const crlf = Buffer.from('﻿---\r\ndescription: d\r\n---\r\nbody\r\n');
    expect(Buffer.from(withSkillName(crlf, 'a:b')).toString()).toBe(
      '﻿---\r\nname: a:b\r\ndescription: d\r\n---\r\nbody\r\n',
    );
    expect(Buffer.from(withSkillName(Buffer.from('# Task\n'), 'task')).toString()).toBe(
      '---\nname: task\n---\n\n# Task\n',
    );
  });

  it('T5 a committed copy without name: still adopts', () => {
    const disk = Buffer.from('---\ndescription: d\n---\n\n# Task\n');
    const rendered = withSkillName(disk, 'task');
    expect(sameContent(disk, rendered, '.agents/skills/task/SKILL.md')).toBe(true);
    expect(sameContent(disk, withSkillName(disk, 'other'), '.agents/skills/task/SKILL.md')).toBe(
      false,
    );
  });
});
