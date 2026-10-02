import { describe, expect, it } from 'vitest';
import type { InstructionDefinition } from '../../src/core/types.js';
import { renderInstruction } from '../../src/targets/convert-instruction.js';

const SCOPED: InstructionDefinition = {
  name: 'ts',
  description: 'TS rules',
  globs: ['**/*.ts', 'src/**/*.tsx'],
  alwaysApply: false,
  activation: 'paths',
  body: '\nUse strict.\n',
};
const ALWAYS: InstructionDefinition = {
  name: 'style',
  alwaysApply: true,
  activation: 'always',
  body: 'Be terse.',
};

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

  it('codex and gemini: a managed block; opencode: a plain file', () => {
    expect(renderInstruction(SCOPED, 'codex')).toEqual({
      managedBlock: 'Applies to: **/*.ts, src/**/*.tsx\n\nUse strict.\n',
    });
    expect(renderInstruction(ALWAYS, 'gemini')).toEqual({ managedBlock: 'Be terse.\n' });
    expect(renderInstruction(ALWAYS, 'opencode')).toEqual({
      fileName: 'style.md',
      content: 'Be terse.\n',
    });
  });
});
