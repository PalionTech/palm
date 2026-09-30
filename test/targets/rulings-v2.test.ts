/**
 * Rulings of the 0.2 persona rerun (FINDINGS-v2.md) on the targets side: one test per ruling id.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import type { Entity, TargetId } from '../../src/core/types.js';
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
