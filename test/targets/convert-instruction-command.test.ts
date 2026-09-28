import { describe, expect, it } from 'vitest';
import type { InstructionDefinition } from '../../src/core/types.js';
import { renderCommand } from '../../src/targets/convert-command.js';
import { renderInstruction } from '../../src/targets/convert-instruction.js';

const SCOPED: InstructionDefinition = {
  name: 'ts',
  description: 'TS rules',
  globs: ['**/*.ts', 'src/**/*.tsx'],
  alwaysApply: false,
  body: '\nUse strict.\n',
};
const ALWAYS: InstructionDefinition = { name: 'style', alwaysApply: true, body: 'Be terse.' };

describe('renderInstruction', () => {
  it('claude', () => {
    expect(renderInstruction(SCOPED, 'claude')).toEqual({
      fileName: 'ts.md',
      content: '---\npaths:\n  - "**/*.ts"\n  - "src/**/*.tsx"\n---\n\nUse strict.\n',
    });
    expect(renderInstruction(ALWAYS, 'claude')).toEqual({
      fileName: 'style.md',
      content: 'Be terse.\n',
    });
  });

  it('copilot', () => {
    expect(renderInstruction(SCOPED, 'copilot')).toEqual({
      fileName: 'ts.instructions.md',
      content: '---\ndescription: TS rules\napplyTo: "**/*.ts,src/**/*.tsx"\n---\n\nUse strict.\n',
    });
    expect(renderInstruction(ALWAYS, 'copilot')).toEqual({
      fileName: 'style.instructions.md',
      content: '---\napplyTo: "**"\n---\n\nBe terse.\n',
    });
  });

  it('cursor', () => {
    expect(renderInstruction(SCOPED, 'cursor')).toEqual({
      fileName: 'ts.mdc',
      content:
        '---\ndescription: TS rules\nglobs: **/*.ts,src/**/*.tsx\nalwaysApply: false\n---\n\nUse strict.\n',
    });
    expect(renderInstruction(ALWAYS, 'cursor')).toEqual({
      fileName: 'style.mdc',
      content: '---\ndescription:\nglobs:\nalwaysApply: true\n---\n\nBe terse.\n',
    });
  });

  it('codex managed block', () => {
    expect(renderInstruction(SCOPED, 'codex')).toEqual({
      managedBlock: 'Applies to: **/*.ts, src/**/*.tsx\n\nUse strict.\n',
    });
    expect(renderInstruction(ALWAYS, 'codex')).toEqual({ managedBlock: 'Be terse.\n' });
  });
});

describe('renderCommand', () => {
  const cmd = {
    name: 'fix',
    description: 'Fix an issue',
    argumentHint: '[issue]',
    body: 'Fix $ARGUMENTS\n',
  };
  it('renders per target', () => {
    const fm = '---\ndescription: Fix an issue\nargument-hint: "[issue]"\n---\n\nFix $ARGUMENTS\n';
    expect(renderCommand(cmd, 'claude')).toEqual({ fileName: 'fix.md', content: fm });
    expect(renderCommand(cmd, 'cursor')).toEqual({ fileName: 'fix.md', content: fm });
    expect(renderCommand(cmd, 'copilot')).toEqual({ fileName: 'fix.prompt.md', content: fm });
    expect(renderCommand(cmd, 'codex')).toEqual({
      fileName: 'fix.md',
      content: 'Fix $ARGUMENTS\n',
    });
    expect(renderCommand({ name: 'bare', body: 'Do it' }, 'claude')).toEqual({
      fileName: 'bare.md',
      content: 'Do it\n',
    });
  });
});
