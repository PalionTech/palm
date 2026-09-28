import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '../../src/core/types.js';
import {
  isClaudeModel,
  renderAgent,
  tomlMultilineString,
} from '../../src/targets/convert-agent.js';

const AGENT: AgentDefinition = {
  name: 'reviewer',
  displayName: 'Code Reviewer',
  description: 'Reviews code: use after edits',
  model: 'opus',
  tools: ['Read', 'Grep'],
  disallowedTools: ['Bash'],
  skills: ['tdd'],
  mcpServers: ['github'],
  color: 'blue',
  body: '\nYou review code.\n',
  extra: { permissionMode: 'plan' },
};

describe('renderAgent', () => {
  it('claude: full frontmatter superset', () => {
    const r = renderAgent(AGENT, 'claude');
    expect(r.fileName).toBe('reviewer.md');
    expect(r.dropped).toEqual([]);
    expect(r.content).toBe(
      [
        '---',
        'name: reviewer',
        'description: "Reviews code: use after edits"',
        'model: opus',
        'tools: Read, Grep',
        'disallowedTools: Bash',
        'skills:',
        '  - tdd',
        'mcpServers:',
        '  - github',
        'color: blue',
        'permissionMode: plan',
        '---',
        '',
        'You review code.',
        '',
      ].join('\n'),
    );
  });

  it('codex: TOML with developer_instructions, Claude model and tool policy dropped', () => {
    const r = renderAgent(AGENT, 'codex');
    expect(r.fileName).toBe('reviewer.toml');
    expect(r.content).toBe(
      'name = "reviewer"\ndescription = "Reviews code: use after edits"\ndeveloper_instructions = """\nYou review code.\n"""\n',
    );
    expect(r.dropped).toEqual([
      'model (opus)',
      'tools',
      'disallowedTools',
      'skills',
      'mcpServers',
      'color',
      'extra: permissionMode',
    ]);
    expect(parse(r.content)).toEqual({
      name: 'reviewer',
      description: 'Reviews code: use after edits',
      developer_instructions: 'You review code.\n',
    });
  });

  it('codex: keeps non-Claude models and Codex extra keys', () => {
    const r = renderAgent(
      {
        name: 'a',
        description: 'd',
        model: 'gpt-6-astra',
        body: 'x',
        extra: { sandbox_mode: 'read-only' },
      },
      'codex',
    );
    expect(parse(r.content)).toEqual({
      name: 'a',
      description: 'd',
      model: 'gpt-6-astra',
      sandbox_mode: 'read-only',
      developer_instructions: 'x\n',
    });
    expect(
      renderAgent({ name: 'a', description: 'd', model: 'claude-opus-5', body: '' }, 'codex')
        .dropped,
    ).toEqual(['model (claude-opus-5)']);
  });

  it('codex: body round-trips through TOML with quotes, backslashes and delimiters', () => {
    const body =
      'Use "quotes", \'single\', """triple""", a \\ backslash, tab\there, \u0001 ctrl\nand a trailing quote"';
    const r = renderAgent({ name: 'a', description: 'd', body }, 'codex');
    expect((parse(r.content) as { developer_instructions: string }).developer_instructions).toBe(
      `${body}\n`,
    );
    expect(parse(`x = ${tomlMultilineString('ends with "')}`)).toEqual({ x: 'ends with "' });
    expect(parse(`x = ${tomlMultilineString('')}`)).toEqual({ x: '' });
  });

  it('copilot: display name, tools list with MCP wildcards, skills dropped', () => {
    const r = renderAgent(AGENT, 'copilot');
    expect(r.fileName).toBe('reviewer.agent.md');
    expect(r.content).toBe(
      [
        '---',
        'name: Code Reviewer',
        'description: "Reviews code: use after edits"',
        'tools:',
        '  - read',
        '  - search',
        '  - github/*',
        '---',
        '',
        'You review code.',
        '',
      ].join('\n'),
    );
    expect(r.dropped).toEqual([
      'model (opus)',
      'mcpServers',
      'skills',
      'disallowedTools',
      'color',
      'extra: permissionMode',
    ]);
    expect(renderAgent({ ...AGENT, model: 'claude-sonnet-4.5' }, 'copilot').content).toContain(
      'model: claude-sonnet-4.5\n',
    );
  });

  it('copilot: tools mapped to Copilot aliases, restrictions and unknown names reported (R8 M9)', () => {
    const r = renderAgent(
      {
        ...AGENT,
        tools: ['Bash(git:*)', 'Edit', 'Write', 'mcp__docs__search', 'mcp__gh', 'Skill', 'web'],
        mcpServers: undefined,
      },
      'copilot',
    );
    const tools = r.content.split('\n').filter((l) => l.startsWith('  - '));
    expect(tools).toEqual(['  - execute', '  - edit', '  - docs/search', '  - gh/*', '  - web']);
    expect(r.dropped).toContain('tools: Bash(git:*) restriction (all of execute)');
    expect(r.dropped).toContain('tools: Skill (no GitHub Copilot equivalent)');
  });

  it('cursor: readonly when no write tools; inherit kept', () => {
    const r = renderAgent(AGENT, 'cursor');
    expect(r.fileName).toBe('reviewer.md');
    expect(r.content).toBe(
      '---\nname: reviewer\ndescription: "Reviews code: use after edits"\nreadonly: true\n---\n\nYou review code.\n',
    );
    expect(r.dropped).toContain('tools (mapped to readonly: true)');
    const w = renderAgent(
      { name: 'w', description: 'd', model: 'inherit', tools: ['Read', 'Edit'], body: 'b' },
      'cursor',
    );
    expect(w.content).toBe('---\nname: w\ndescription: d\nmodel: inherit\n---\n\nb\n');
  });

  it('every harness gets bare dependency names (tdd@mattpocock#v1 → tdd)', () => {
    const pinned = {
      ...AGENT,
      skills: ['tdd@mattpocock', 'wayfinder@mattpocock#v1.2.0', 'tdd'],
      mcpServers: ['github@pstack'],
    };
    expect(renderAgent(pinned, 'claude').content).toContain(
      'skills:\n  - tdd\n  - wayfinder\nmcpServers:\n  - github\n',
    );
    expect(renderAgent(pinned, 'copilot').content).toContain('github/*');
    expect(renderAgent(pinned, 'gemini').content).toContain('mcp_github_*');
    for (const t of ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode'] as const)
      expect(renderAgent(pinned, t).content).not.toMatch(/@mattpocock|@pstack|#v1/);
  });

  it('minimal agent renders without optional keys everywhere', () => {
    const def: AgentDefinition = { name: 'm', description: 'Minimal', body: 'Body' };
    expect(renderAgent(def, 'claude').content).toBe(
      '---\nname: m\ndescription: Minimal\n---\n\nBody\n',
    );
    expect(renderAgent(def, 'copilot').content).toBe(
      '---\nname: m\ndescription: Minimal\n---\n\nBody\n',
    );
    expect(renderAgent(def, 'cursor').content).toBe(
      '---\nname: m\ndescription: Minimal\n---\n\nBody\n',
    );
    for (const t of ['claude', 'codex', 'copilot', 'cursor'] as const)
      expect(renderAgent(def, t).dropped).toEqual([]);
  });

  it('classifies Claude models', () => {
    for (const m of [
      'opus',
      'Sonnet',
      'haiku',
      'inherit',
      'opusplan',
      'sonnet[1m]',
      'claude-opus-5',
    ])
      expect(isClaudeModel(m)).toBe(true);
    for (const m of ['gpt-6-astra', 'o4-mini', 'composer-2']) expect(isClaudeModel(m)).toBe(false);
  });
});
