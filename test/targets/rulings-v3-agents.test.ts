/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) for instructions and agents: native
 * files pass through, Copilot tool names map, unknown models drop. One test per ruling id.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, TargetId } from '../../src/core/types.js';
import { parseInstructionFile } from '../../src/index/instructions.js';
import { knownModel } from '../../src/targets/agent-models.js';
import { renderAgent } from '../../src/targets/convert-agent.js';
import { createTarget } from '../../src/targets/index.js';
import { sameContent } from '../../src/targets/same-content.js';
import { claudeToolsFromCopilot } from '../../src/targets/tool-names.js';
import { cleanupTmp, fakeEnv, mkEntity, renderInput, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

async function renderRule(id: TargetId, rel: string, text: string) {
  const src = await tmpDir('palm-source-');
  const abs = path.join(src, rel);
  await write(abs, text);
  const instruction = parseInstructionFile(abs, text);
  const entity = mkEntity({ kind: 'instruction', instruction }, instruction.name, rel);
  const root = await tmpDir();
  const c = { entity, absPath: abs, scope: 'project' as const, scopeRoot: root, sourceRoot: src };
  return createTarget(id, fakeEnv(root)).render(renderInput({ ...c, targets: [id] }));
}

const text = (data: Uint8Array | undefined): string => Buffer.from(data ?? []).toString();

describe('O9 a Copilot instruction file passes through for copilot byte for byte', () => {
  it('O9 applyTo "a, b" stays as written for copilot and is converted for claude', async () => {
    const md = '---\ndescription: Go style\napplyTo: "**/*.go, **/go.mod"\n---\n\nUse gofmt.\n';
    const rel = '.github/instructions/golang.instructions.md';
    const copilot = await renderRule('copilot', rel, md);
    expect(copilot.files.map((f) => f.path)).toEqual([
      '.github/instructions/golang.instructions.md',
    ]);
    expect(text(copilot.files[0]?.data)).toBe(md);
    const claude = await renderRule('claude', rel, md);
    expect(text(claude.files[0]?.data)).toContain('paths:\n');
  });
});

describe("Y8' a Cursor .mdc passes through for cursor; empty keys and quoting compare as absent", () => {
  it("Y8' a quoted description and no globs key stay as written for cursor", async () => {
    const mdc = '---\ndescription: "Review checklist"\nalwaysApply: false\n---\nCheck it.\n';
    const cursor = await renderRule('cursor', '.cursor/rules/review.mdc', mdc);
    expect(cursor.files.map((f) => f.path)).toEqual(['.cursor/rules/review.mdc']);
    expect(text(cursor.files[0]?.data)).toBe(mdc);
  });

  it("Y8' an on-disk rule with empty keys and other quoting adopts", () => {
    const file = '.cursor/rules/review.mdc';
    const disk = Buffer.from(
      "---\ndescription: 'Review checklist'\nglobs:\nalwaysApply: false\n---\nCheck it.\n",
    );
    const rendered = Buffer.from(
      '---\ndescription: "Review checklist"\nalwaysApply: false\n---\nCheck it.\n',
    );
    expect(sameContent(disk, rendered, file)).toBe(true);
    const other = Buffer.from('---\ndescription: Other\nalwaysApply: false\n---\nCheck it.\n');
    expect(sameContent(disk, other, file)).toBe(false);
  });
});

const copilotAgent: AgentDefinition = {
  name: 'planner',
  description: 'Plans the change',
  tools: ['read', 'search', 'execute', 'agent', 'github/*', 'vscodeApi'],
  body: 'Plan first.\n',
  sourceFormat: 'copilot-agent-md',
};

describe('O14 Copilot tool names are mapped to Claude names and back', () => {
  it('O14 read, search, execute, agent become Read, Grep, Glob, Bash, Task for claude', () => {
    const r = renderAgent(copilotAgent, 'claude');
    expect(r.content).toContain('tools: Read, Grep, Glob, Bash, Task, mcp__github\n');
    expect(r.dropped).toEqual(['tools: vscodeApi (a GitHub Copilot tool)']);
  });

  it('O14 the Copilot render keeps Copilot names; other harnesses map through Claude names', () => {
    const copilot = renderAgent(copilotAgent, 'copilot');
    expect(copilot.content).toContain(
      'tools:\n  - read\n  - search\n  - execute\n  - agent\n  - github/*\n',
    );
    expect(renderAgent(copilotAgent, 'gemini').content).toContain('run_shell_command');
    const cursor = renderAgent({ ...copilotAgent, tools: ['read', 'search'] }, 'cursor');
    expect(cursor.content).toContain('readonly: true\n');
  });

  it('O14 a Claude agent keeps Claude names; `*` in a Copilot agent means every tool', () => {
    expect(claudeToolsFromCopilot(['*', 'read'])).toEqual({
      tools: ['Read'],
      all: true,
      unmapped: [],
    });
    expect(renderAgent({ ...copilotAgent, tools: ['*'] }, 'claude').content).not.toContain(
      'tools:',
    );
    const claude = renderAgent(
      { ...copilotAgent, sourceFormat: 'claude-md', tools: ['Read'] },
      'copilot',
    );
    expect(claude.content).toContain('tools:\n  - read\n');
  });
});

describe("Y9' every harness drops a model it does not know, with a note", () => {
  const agent = (
    model: string,
    sourceFormat?: AgentDefinition['sourceFormat'],
  ): AgentDefinition => ({
    name: 'worker',
    description: 'd',
    model,
    body: 'b',
    ...(sourceFormat ? { sourceFormat } : {}),
  });

  it("Y9' a Cursor model id is dropped for claude; Claude ids and aliases stay", () => {
    expect(renderAgent(agent('claude-4.5-opus-high-thinking'), 'claude').dropped).toEqual([
      'model (claude-4.5-opus-high-thinking)',
    ]);
    for (const m of ['opus', 'claude-opus-4-5', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'])
      expect(renderAgent(agent(m), 'claude').dropped).toEqual([]);
  });

  it("Y9' codex, gemini, copilot, cursor and opencode drop models they do not know", () => {
    const dropped: Array<[TargetId, string]> = [
      ['codex', 'fast'],
      ['codex', 'composer-2'],
      ['gemini', 'gpt-5'],
      ['copilot', 'fast'],
      ['cursor', 'anthropic/claude-sonnet-4-5'],
      ['opencode', 'gemini-2.5-pro'],
    ];
    for (const [target, m] of dropped)
      expect(renderAgent(agent(m), target).dropped, `${target} ${m}`).toEqual([`model (${m})`]);
    const kept: Array<[TargetId, string]> = [
      ['codex', 'gpt-5-codex'],
      ['gemini', 'gemini-2.5-pro'],
      ['cursor', 'fast'],
      ['opencode', 'openai/gpt-5'],
    ];
    for (const [target, m] of kept)
      expect(renderAgent(agent(m), target).dropped, `${target} ${m}`).toEqual([]);
  });

  it("Y9' an agent in the harness's own format keeps its model", () => {
    expect(renderAgent(agent('llama3.1', 'codex-toml'), 'codex').dropped).toEqual([]);
    expect(renderAgent(agent('fast', 'cursor-md'), 'cursor').dropped).toEqual([]);
    expect(knownModel('claude', 'fast')).toBe(false);
  });
});
