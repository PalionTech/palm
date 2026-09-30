import { describe, expect, it } from 'vitest';
import type { CommandAsSkill, SkillDefinition } from '../../src/core/types.js';
import { TARGET_IDS } from '../../src/core/types.js';
import { renderCommandAsSkill } from '../../src/targets/convert-skill.js';
import { createTarget } from '../../src/targets/index.js';
import { cleanupTmp, fakeEnv, mkEntity, renderInput, tmpDir } from './helpers.js';

const FIX: SkillDefinition & { fromCommand: CommandAsSkill } = {
  name: 'fix',
  description: 'Fix an issue',
  fromCommand: {
    body: '\nFix $ARGUMENTS and report.\n',
    argumentHint: '[issue]',
    sourceFormat: 'claude-md',
  },
};

describe('renderCommandAsSkill', () => {
  it('claude and cursor: SKILL.md with name, description, argument-hint; $ARGUMENTS as written', () => {
    for (const t of ['claude', 'cursor'] as const)
      expect(renderCommandAsSkill(FIX, t)).toEqual({
        content:
          '---\nname: fix\ndescription: Fix an issue\nargument-hint: "[issue]"\n---\n\nFix $ARGUMENTS and report.\n',
        notes: [],
      });
  });

  it('the other harnesses: no argument-hint, and a note that $ARGUMENTS stays as written', () => {
    const r = renderCommandAsSkill(FIX, 'gemini');
    expect(r.content).toBe(
      '---\nname: fix\ndescription: Fix an issue\n---\n\nFix $ARGUMENTS and report.\n',
    );
    expect(r.notes).toEqual([
      'skill fix (from a command): Gemini CLI does not expand $ARGUMENTS in skills; the text stays as written',
    ]);
    for (const t of ['codex', 'copilot', 'opencode'] as const)
      expect(renderCommandAsSkill(FIX, t).notes).toHaveLength(1);
  });

  it('a body without placeholders needs no note', () => {
    const plain = { ...FIX, fromCommand: { ...FIX.fromCommand, body: 'Tidy up.\n' } };
    expect(renderCommandAsSkill(plain, 'codex').notes).toEqual([]);
  });
});

describe('a command file renders at the skill locations of every harness', () => {
  it.each(TARGET_IDS)('%s', async (id) => {
    const root = await tmpDir();
    const entity = mkEntity({ kind: 'skill', skill: FIX }, 'fix', 'commands/fix.md');
    const input = renderInput({
      entity,
      absPath: `${root}/src/commands/fix.md`,
      sourceRoot: `${root}/src`,
      scope: 'project',
      scopeRoot: root,
    });
    const r = await createTarget(id, fakeEnv(root)).render(input);
    expect(r.files.map((f) => f.path)).toEqual([
      id === 'claude' ? '.claude/skills/fix/SKILL.md' : '.agents/skills/fix/SKILL.md',
    ]);
    expect(Buffer.from(r.files[0]!.data).toString('utf8')).toContain('Fix $ARGUMENTS and report.');
    expect(r.notes.some((n) => n.includes('$ARGUMENTS'))).toBe(id !== 'claude' && id !== 'cursor');
    await cleanupTmp();
  });
});
