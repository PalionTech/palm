import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { LockEntry, OriginIndex, PickOption, UI } from '../../src/core/types.js';
import {
  buildEntityOptions,
  buildInstructionOptions,
  collectAgentAnswers,
  pickManyWithSearch,
  renderAgentFile,
  type AgentAnswers,
} from '../../src/create/agent.js';
import { renderCommandFile } from '../../src/create/command.js';
import { parseGlobList, renderInstructionFile } from '../../src/create/instruction.js';
import { stripHtmlComments, validateSlug } from '../../src/create/shared.js';
import { renderSkillFile, validateSkillDescription } from '../../src/create/skill.js';

function frontmatter(file: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(file);
  if (!m) throw new Error(`no frontmatter in:\n${file}`);
  return { data: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
}

type Answer = unknown | ((options: PickOption<unknown>[], initial: unknown[]) => unknown);

/** Fake UI that answers prompts in order and records what was asked. */
function scriptedUI(answers: Answer[]): UI & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (type: string, message: string, options: PickOption<unknown>[] = [], initial: unknown[] = []) => {
    asked.push(`${type}: ${message}`);
    if (queue.length === 0) throw new Error(`unexpected prompt ${type}: ${message}`);
    const a = queue.shift();
    return typeof a === 'function' ? (a as (o: PickOption<unknown>[], i: unknown[]) => unknown)(options, initial) : a;
  };
  return {
    isInteractive: true,
    asked,
    pick: async <T>(m: string, o: PickOption<T>[]) => next('pick', m, o as PickOption<unknown>[]) as T,
    pickMany: async <T>(m: string, o: PickOption<T>[], i?: T[]) => next('pickMany', m, o as PickOption<unknown>[], (i ?? []) as unknown[]) as T[],
    confirm: async (m: string) => next('confirm', m) as boolean,
    text: async (m: string, o?: { validate?: (v: string) => string | undefined }) => {
      const v = next('text', m) as string;
      const err = o?.validate?.(v);
      if (err) throw new Error(`validation failed for "${m}": ${err}`);
      return v;
    },
    secret: async (m: string) => next('secret', m) as string,
    spinner: () => ({ stop() {}, message() {} }),
  };
}

const byLabel = (label: string) => (options: PickOption<unknown>[]) => {
  const o = options.find((x) => x.label.startsWith(label));
  if (!o) throw new Error(`no option ${label} in ${options.map((x) => x.label).join(', ')}`);
  return [o.value];
};

describe('renderAgentFile', () => {
  const base: AgentAnswers = {
    name: 'code-reviewer',
    description: 'Use proactively after code changes: reviews diffs.',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    skills: ['tdd', 'wayfinder'],
    mcpServers: ['github'],
    instructions: ['ts-style@mine'],
    body: '\nYou are a meticulous reviewer.\n\n## Process\n\n1. Read the diff.\n',
  };

  it('writes canonical Claude frontmatter plus skills, mcpServers and palm instructions', () => {
    const file = renderAgentFile(base);
    const { data, body } = frontmatter(file);
    expect(Object.keys(data)).toEqual(['name', 'description', 'model', 'tools', 'skills', 'mcpServers', 'instructions']);
    expect(data).toEqual({
      name: 'code-reviewer',
      description: 'Use proactively after code changes: reviews diffs.',
      model: 'sonnet',
      tools: 'Read, Grep, Glob',
      skills: ['tdd', 'wayfinder'],
      mcpServers: ['github'],
      instructions: ['ts-style@mine'],
    });
    expect(body).toBe('You are a meticulous reviewer.\n\n## Process\n\n1. Read the diff.\n');
  });

  it('omits model when inherited and empty lists', () => {
    const { data } = frontmatter(renderAgentFile({ ...base, model: 'inherit', tools: [], skills: [], mcpServers: [], instructions: [] }));
    expect(data).toEqual({ name: 'code-reviewer', description: base.description });
    const { data: noModel } = frontmatter(renderAgentFile({ ...base, model: undefined }));
    expect(noModel).not.toHaveProperty('model');
  });
});

describe('stripHtmlComments', () => {
  it('removes single and multi-line comments and tidies blank lines', () => {
    const input = '<!--\n  instructions\n  more\n-->\n\nYou are X.   \n\n<!-- inline -->\n\n\n## Steps\n1. a <!-- note --> b\n';
    expect(stripHtmlComments(input)).toBe('You are X.\n\n## Steps\n1. a  b');
  });

  it('returns an empty string for a template left untouched', () => {
    expect(stripHtmlComments('<!-- only a comment -->\n\n')).toBe('');
  });
});

describe('other create renderers', () => {
  it('renderSkillFile has name, description and the section template', () => {
    const { data, body } = frontmatter(renderSkillFile({ name: 'release-notes', description: 'Use when drafting release notes.' }));
    expect(data).toEqual({ name: 'release-notes', description: 'Use when drafting release notes.' });
    expect(body).toContain('# Release Notes');
    for (const h of ['## When to use', '## Steps', '## Notes']) expect(body).toContain(h);
  });

  it('renderInstructionFile writes paths only for globs and alwaysApply only when it differs', () => {
    expect(frontmatter(renderInstructionFile({ description: 'TS style', globs: [], alwaysApply: true, body: '- a' })).data).toEqual({ description: 'TS style' });
    expect(frontmatter(renderInstructionFile({ description: 'TS', globs: ['src/**/*.ts'], alwaysApply: false, body: '- a' })).data).toEqual({
      description: 'TS',
      paths: ['src/**/*.ts'],
    });
    expect(frontmatter(renderInstructionFile({ globs: [], alwaysApply: false, body: '- a' })).data).toEqual({ alwaysApply: false });
    expect(parseGlobList(' a/**, ,b ')).toEqual(['a/**', 'b']);
  });

  it('renderCommandFile writes argument-hint when given', () => {
    const { data, body } = frontmatter(renderCommandFile({ description: 'Fix an issue', argumentHint: '[n]', body: 'Fix $ARGUMENTS' }));
    expect(data).toEqual({ description: 'Fix an issue', 'argument-hint': '[n]' });
    expect(body).toBe('Fix $ARGUMENTS\n');
    expect(frontmatter(renderCommandFile({ description: 'x', argumentHint: '', body: 'y' })).data).toEqual({ description: 'x' });
  });

  it('validates slugs and skill descriptions', () => {
    expect(validateSlug('code-reviewer')).toBeUndefined();
    expect(validateSlug('Code Reviewer')).toBeDefined();
    expect(validateSlug('a--b')).toBeDefined();
    expect(validateSlug('')).toBeDefined();
    expect(validateSkillDescription('x'.repeat(1025))).toMatch(/1024/);
    expect(validateSkillDescription('Use when …')).toBeUndefined();
  });
});

describe('agent wizard options', () => {
  const lock = (kind: LockEntry['kind'], name: string, origin: string): LockEntry => ({
    kind,
    name,
    origin,
    path: name,
    contentHash: 'sha256:x',
    installedAt: '2026-09-27T00:00:00Z',
    targets: ['claude'],
    files: [],
  });
  const index = (origin: string, entities: Array<[OriginIndex['entities'][number]['kind'], string, string?]>): OriginIndex => ({
    origin,
    originId: origin,
    root: `/tmp/${origin}`,
    scannedAt: '2026-09-27T00:00:00Z',
    detected: 'convention',
    warnings: [],
    entities: entities.map(([kind, name, description]) => ({
      kind,
      name,
      description,
      origin,
      path: name,
      def: { kind: 'plugin', members: [] },
    })) as OriginIndex['entities'],
  });

  it('buildEntityOptions lists installed first and dedupes by name', () => {
    const opts = buildEntityOptions(
      'skill',
      [lock('skill', 'tdd', 'mattpocock'), lock('mcp', 'github', 'registry')],
      [index('mattpocock', [['skill', 'tdd'], ['skill', 'wayfinder', 'Plan refactors']]), index('other', [['skill', 'wayfinder'], ['agent', 'x']])],
    );
    expect(opts).toEqual([
      { value: 'tdd', label: 'tdd @mattpocock', hint: 'installed' },
      { value: 'wayfinder', label: 'wayfinder @mattpocock', hint: 'Plan refactors' },
    ]);
  });

  it('buildInstructionOptions keeps the origin in the value', () => {
    expect(buildInstructionOptions([index('mine', [['instruction', 'ts-style']])])).toEqual([{ value: 'ts-style@mine', label: 'ts-style @mine', hint: undefined }]);
  });

  it('pickManyWithSearch filters by a query and keeps earlier picks', async () => {
    const all = [
      { value: 'alpha', label: 'alpha @x' },
      { value: 'beta', label: 'beta @y', hint: 'database helper' },
      { value: 'gamma', label: 'gamma @x' },
    ];
    let secondOptions: string[] = [];
    const ui = scriptedUI([
      () => ['alpha', '\u0000search'], // pick alpha, then search
      'database',
      (options: PickOption<unknown>[], initial: unknown[]) => {
        secondOptions = options.map((o) => String(o.value));
        return [...initial, 'beta'];
      },
    ]);
    const picked = await pickManyWithSearch(ui, 'Skills', all, { noun: 'skills' });
    expect(picked).toEqual(['alpha', 'beta']);
    expect(secondOptions).toEqual(['\u0000search', 'alpha', 'beta']);
  });
});

describe('collectAgentAnswers', () => {
  it('asks the DESIGN §8 questions in order and returns the answers', async () => {
    const registryQueries: string[] = [];
    const ui = scriptedUI([
      'code-reviewer', // name
      'Use after code changes', // description
      'sonnet', // model
      ['Read', 'Grep'], // tools
      byLabel('search skills'), // skills: search…
      'way',
      (options: PickOption<unknown>[]) => options.filter((o) => o.label.startsWith('wayfinder')).map((o) => o.value),
      byLabel('search the MCP registry'), // mcp: registry
      'github',
      ['io.github.github/github-mcp-server'], // registry results
      (_o: PickOption<unknown>[], initial: unknown[]) => [...initial, 'fs'], // back in the MCP list
      ['ts-style@mine'], // instructions
    ]);
    const answers = await collectAgentAnswers(
      ui,
      {
        skills: [
          { value: 'tdd', label: 'tdd @mattpocock' },
          { value: 'wayfinder', label: 'wayfinder @mattpocock' },
        ],
        mcp: [{ value: 'fs', label: 'fs @mine' }],
        instructions: [{ value: 'ts-style@mine', label: 'ts-style @mine' }],
        searchRegistry: async (q) => {
          registryQueries.push(q);
          return [{ value: 'io.github.github/github-mcp-server', label: 'io.github.github/github-mcp-server' }];
        },
        editBody: async (template) => {
          expect(template).toContain('code-reviewer');
          return 'You are a reviewer.';
        },
      },
      { name: 'code-reviewer' },
    );

    expect(answers).toEqual({
      name: 'code-reviewer',
      description: 'Use after code changes',
      model: 'sonnet',
      tools: ['Read', 'Grep'],
      skills: ['wayfinder'],
      mcpServers: ['io.github.github/github-mcp-server', 'fs'],
      instructions: ['ts-style@mine'],
      body: 'You are a reviewer.',
    });
    expect(registryQueries).toEqual(['github']);
    expect(ui.asked.slice(0, 4)).toEqual([
      'text: Agent name',
      'text: When should the main agent delegate to it?',
      'pick: Model',
      'pickMany: Tools (select none to inherit all tools)',
    ]);
  });

  it('asks for a model id when custom is chosen and maps inherit to undefined', async () => {
    const run = (model: string, extra: unknown[]) =>
      collectAgentAnswers(
        scriptedUI(['x', 'desc', model, ...extra, []]),
        { skills: [], mcp: [], instructions: [], editBody: async () => 'body' },
        {},
      );
    expect((await run('\u0000custom', ['my-model'])).model).toBe('my-model');
    expect((await run('inherit', [])).model).toBeUndefined();
  });

  it('rejects an invalid slug', async () => {
    await expect(
      collectAgentAnswers(scriptedUI(['Not A Slug']), { skills: [], mcp: [], instructions: [], editBody: async () => '' }, {}),
    ).rejects.toThrow(/lowercase/);
  });
});
