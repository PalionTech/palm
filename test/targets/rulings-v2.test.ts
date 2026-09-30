/**
 * Rulings of the 0.2 persona rerun (FINDINGS-v2.md) on the targets side: one test per ruling id.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import type { Entity, InstructionDefinition, TargetId } from '../../src/core/types.js';
import { createTarget } from '../../src/targets/index.js';
import { cleanupTmp, fakeEnv, mkEntity, renderInput, SKILL_MD, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const skillEntity = (name = 'demo', entityPath = `skills/${name}`): Entity =>
  mkEntity({ kind: 'skill', skill: { name, description: 'Demo skill' } }, name, entityPath);

async function renderSkill(
  id: TargetId,
  src: { root: string; dir: string; entityPath: string },
  opts: { targets?: TargetId[]; force?: boolean } = {},
) {
  const root = await tmpDir();
  const entity = skillEntity('demo', src.entityPath);
  const input = renderInput(
    {
      entity,
      absPath: src.dir,
      scope: 'project',
      scopeRoot: root,
      sourceRoot: src.root,
      targets: opts.targets ?? [id],
    },
    opts.force ? { force: true } : {},
  );
  return createTarget(id, fakeEnv(root)).render(input);
}

describe('Y2 a skill copy leaves out harness directories, palm files and keys', () => {
  it('Y2 a root skill copies its content, never .cursor, .claude, .git, palm files or .env', async () => {
    const root = await tmpDir('palm-source-');
    await write(path.join(root, 'SKILL.md'), SKILL_MD);
    await write(path.join(root, 'scripts/run.sh'), '#!/bin/sh\necho run\n', 0o755);
    for (const junk of [
      '.cursor/mcp.json',
      '.cursor/rules/a.mdc',
      '.claude/settings.json',
      '.agents/skills/x/SKILL.md',
      '.github/workflows/ci.yml',
      '.git/HEAD',
      'node_modules/x/index.js',
      '.mcp.json',
      'AGENTS.md',
      'CLAUDE.md',
      'palm.yaml',
      'palm.lock.yaml',
      '.palm/assets/x.sh',
      '.env',
      '.env.local',
      'packages/cli/.cursor/mcp.json',
    ])
      await write(path.join(root, junk), 'x\n');
    const r = await renderSkill('claude', { root, dir: root, entityPath: '.' });
    expect(r.files.map((f) => f.path)).toEqual([
      '.claude/skills/demo/SKILL.md',
      '.claude/skills/demo/scripts/run.sh',
    ]);
    expect(r.notes.join('\n')).toMatch(
      /skill demo: left out \.agents, \.claude, \.cursor \+\d+ \(harness, palm and \.env files are not skill content\)/,
    );
  });

  it('Y2 a skill above 200 files needs --force, with the count in the message', async () => {
    const root = await tmpDir('palm-source-');
    const dir = path.join(root, 'skills/demo');
    await write(path.join(dir, 'SKILL.md'), SKILL_MD);
    for (let i = 0; i < 1191; i++) await write(path.join(dir, `ref/${i}.md`), `# ${i}\n`);
    const err = await renderSkill('claude', { root, dir, entityPath: 'skills/demo' }).catch(
      (e: unknown) => e,
    );
    expect(isPalmError(err) && err.code).toBe('E_SOURCE');
    expect((err as Error).message).toMatch(
      /^skill demo: 1,192 files \(0\.0 MB\) to copy; a skill above 200 files or 5 MB needs --force$/,
    );
    expect(isPalmError(err) && err.retryWith).toBe('--force');
    const forced = await renderSkill(
      'claude',
      { root, dir, entityPath: 'skills/demo' },
      { force: true },
    );
    expect(forced.files).toHaveLength(1192);
  });

  it('Y2 a skill above 5 MB needs --force', async () => {
    const root = await tmpDir('palm-source-');
    const dir = path.join(root, 'skills/demo');
    await write(path.join(dir, 'SKILL.md'), SKILL_MD);
    await write(path.join(dir, 'data.txt'), 'x'.repeat(5 * 1024 * 1024 + 1));
    const err = await renderSkill('claude', { root, dir, entityPath: 'skills/demo' }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/2 files \(5\.0 MB\) to copy/);
  });
});

describe('J agents/openai.yaml lands only in .agents/skills copies', () => {
  async function source() {
    const root = await tmpDir('palm-source-');
    const dir = path.join(root, 'skills/demo');
    await write(path.join(dir, 'SKILL.md'), SKILL_MD);
    await write(path.join(dir, 'agents/openai.yaml'), 'interface:\n  display_name: Demo\n');
    return { root, dir, entityPath: 'skills/demo' };
  }

  it('J claude gets no agents/openai.yaml; codex keeps it', async () => {
    const src = await source();
    const claude = await renderSkill('claude', src, { targets: ['claude', 'codex'] });
    const codex = await renderSkill('codex', src, { targets: ['claude', 'codex'] });
    expect(claude.files.map((f) => f.path)).toEqual(['.claude/skills/demo/SKILL.md']);
    expect(codex.files.map((f) => f.path)).toEqual([
      '.agents/skills/demo/SKILL.md',
      '.agents/skills/demo/agents/openai.yaml',
    ]);
  });

  it('J cursor writing into .claude/skills leaves it out too', async () => {
    const src = await source();
    const cursor = await renderSkill('cursor', src, { targets: ['claude', 'cursor'] });
    expect(cursor.files.map((f) => f.path)).toEqual(['.claude/skills/demo/SKILL.md']);
  });
});

describe('Y15 an AGENTS.md alone never marks Codex', () => {
  it('Y15 AGENTS.md is no evidence; .codex is, and evidence names it', async () => {
    const root = await tmpDir();
    const env = fakeEnv(root);
    const codex = createTarget('codex', env);
    await write(path.join(root, 'AGENTS.md'), '# repo\n');
    expect(await codex.detect('project', root, env)).toBe(false);
    expect(await codex.evidence('project', root, env)).toBeUndefined();
    await fs.mkdir(path.join(root, '.codex'));
    expect(await codex.detect('project', root, env)).toBe(true);
    expect(await codex.evidence('project', root, env)).toBe(path.join(root, '.codex'));
    await write(path.join(root, 'CLAUDE.md'), '');
    const claude = createTarget('claude', env);
    expect(await claude.evidence('project', root, env)).toBe(path.join(root, 'CLAUDE.md'));
  });
});

/** A source holding one instruction file, with the definition the index gives it. */
async function instructionCase(rel: string, text: string, def: InstructionDefinition) {
  const root = await tmpDir('palm-source-');
  const abs = path.join(root, rel);
  await write(abs, text);
  const entity = mkEntity({ kind: 'instruction', instruction: def }, def.name, rel);
  return { root, abs, entity };
}

async function renderInstructionFor(id: TargetId, c: Awaited<ReturnType<typeof instructionCase>>) {
  const scopeRoot = await tmpDir();
  const input = renderInput({
    entity: c.entity,
    absPath: c.abs,
    scope: 'project',
    scopeRoot,
    sourceRoot: c.root,
    targets: [id],
  });
  return createTarget(id, fakeEnv(scopeRoot)).render(input);
}

describe('B12 a Claude rule installed for claude is byte-identical', () => {
  const text =
    '---\r\ndescription: React rules\r\npaths:\r\n  - src/**/*.tsx\r\n---\r\n\r\nUse hooks.  \r\n';
  const def: InstructionDefinition = {
    name: 'react-rules',
    description: 'React rules',
    globs: ['src/**/*.tsx'],
    alwaysApply: false,
    activation: 'paths',
    body: '\r\nUse hooks.  \r\n',
    sourceFormat: 'claude-md',
    fileName: 'React-Rules.md',
  };

  it('B12 frontmatter, line ends and file name case are kept for claude', async () => {
    const c = await instructionCase('rules/React-Rules.md', text, def);
    const r = await renderInstructionFor('claude', c);
    expect(r.files.map((f) => [f.path, Buffer.from(f.data).toString('utf8')])).toEqual([
      ['.claude/rules/React-Rules.md', text],
    ]);
  });

  it('B12 other harnesses get the converted rule', async () => {
    const c = await instructionCase('rules/React-Rules.md', text, def);
    const r = await renderInstructionFor('copilot', c);
    expect(r.files.map((f) => f.path)).toEqual([
      '.github/instructions/react-rules.instructions.md',
    ]);
  });

  it('B12 a rule with Cursor keys (sourceFormat md) is converted for claude too', async () => {
    const c = await instructionCase('rules/api.md', '---\nglobs: src/**\n---\nBody\n', {
      name: 'api',
      globs: ['src/**'],
      alwaysApply: false,
      activation: 'paths',
      body: 'Body\n',
      sourceFormat: 'md',
    });
    const r = await renderInstructionFor('claude', c);
    expect(Buffer.from(r.files[0]?.data ?? []).toString('utf8')).toBe(
      '---\npaths:\n  - "src/**"\n---\n\nBody\n',
    );
  });
});

describe('Y3 a widened instruction gets a notice per harness', () => {
  const mdc = (name: string, activation: InstructionDefinition['activation']) =>
    instructionCase(`rules/${name}.mdc`, '---\nalwaysApply: false\n---\nx\n', {
      name,
      alwaysApply: activation === 'always',
      activation,
      body: 'x\n',
      sourceFormat: 'mdc',
    });

  it('Y3 on-request and manual rules say where they become always-on', async () => {
    const onRequest = await mdc('review', 'on-request');
    for (const id of ['claude', 'codex', 'copilot', 'gemini', 'opencode'] as const) {
      const r = await renderInstructionFor(id, onRequest);
      expect(r.notes).toContain(
        `instruction review: on-request in the source, always-on for ${id} until 0.3`,
      );
    }
    expect((await renderInstructionFor('cursor', onRequest)).notes).toEqual([]);
    expect((await renderInstructionFor('claude', await mdc('pick', 'manual'))).notes).toEqual([
      'instruction pick: manual in the source, always-on for claude until 0.3',
    ]);
    expect((await renderInstructionFor('codex', await mdc('all', 'always'))).notes).toEqual([]);
  });
});
