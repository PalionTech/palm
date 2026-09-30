/**
 * Rulings of the 0.2 persona rerun (FINDINGS-v2.md) on the targets side: one test per ruling id.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import type {
  AgentDefinition,
  Entity,
  HookSet,
  InstructionDefinition,
  TargetId,
} from '../../src/core/types.js';
import { renderAgent } from '../../src/targets/convert-agent.js';
import { convertHooks, type Relocate } from '../../src/targets/convert-hooks.js';
import { createTarget } from '../../src/targets/index.js';
import { sameContent } from '../../src/targets/same-content.js';
import {
  allKinds,
  cleanupTmp,
  exists,
  fakeEnv,
  install,
  makeSource,
  mkEntity,
  renderInput,
  SKILL_MD,
  tmpDir,
  write,
} from './helpers.js';

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

describe('Y10 foreign agent keys and readonly', () => {
  const cursorAgent: AgentDefinition = {
    name: 'worker',
    description: 'Does work',
    model: 'fast',
    body: 'Work.\n',
    extra: { readonly: true, is_background: true, permissionMode: 'plan' },
    sourceFormat: 'cursor-md',
  };

  it('Y10 claude drops a model and keys it cannot use and maps readonly to a read-only tool list', () => {
    const r = renderAgent(cursorAgent, 'claude');
    expect(r.content).toBe(
      '---\nname: worker\ndescription: Does work\ntools: Read, Grep, Glob, WebFetch, WebSearch\npermissionMode: plan\n---\n\nWork.\n',
    );
    expect(r.dropped).toEqual(['model (fast)', 'extra: is_background']);
    expect(r.notes).toEqual([
      'readonly: true written as tools: Read, Grep, Glob, WebFetch, WebSearch',
    ]);
  });

  it('Y10 readonly with a tool list takes the write and run tools out', () => {
    const r = renderAgent(
      { ...cursorAgent, model: 'sonnet', tools: ['Read', 'Edit', 'Bash(git:*)'] },
      'claude',
    );
    expect(r.content).toContain('model: sonnet\ntools: Read\n');
    expect(r.notes).toEqual(['readonly: true: Edit, Bash(git:*) left out of tools']);
  });

  it('Y10 opencode gets permission denials for readonly; codex a read-only sandbox', () => {
    const open = renderAgent(cursorAgent, 'opencode');
    expect(open.content).toContain('permission:\n  edit: deny\n  bash: deny\n');
    expect(open.dropped).not.toContain('extra: readonly');
    expect(open.notes).toEqual(['readonly: true written as permission edit: deny, bash: deny']);
    const codex = renderAgent(cursorAgent, 'codex');
    expect(codex.content).toContain('sandbox_mode = "read-only"');
  });

  it('Y10 a Claude model and Claude keys stay for claude', () => {
    const r = renderAgent(
      {
        name: 'a',
        description: 'd',
        model: 'fable',
        body: 'b',
        extra: { maxTurns: 5, effort: 'high' },
      },
      'claude',
    );
    expect(r.content).toBe(
      '---\nname: a\ndescription: d\nmodel: fable\nmaxTurns: 5\neffort: high\n---\n\nb\n',
    );
    expect(r.dropped).toEqual([]);
  });
});

describe('E9 Cursor readonly only when no tool writes or runs programs', () => {
  it('E9 Bash in the tool list means no readonly', () => {
    const base: AgentDefinition = { name: 'a', description: 'd', body: 'b' };
    expect(renderAgent({ ...base, tools: ['Read', 'Bash'] }, 'cursor').content).not.toContain(
      'readonly',
    );
    expect(renderAgent({ ...base, tools: ['Read', 'Grep'] }, 'cursor').content).toContain(
      'readonly: true',
    );
  });
});

const asIs: Relocate = (command) => ({ canonical: command, rendered: command });
const hookSet = (dialect: HookSet['dialect'], raw: unknown): HookSet => ({
  name: 'h',
  dialect,
  raw,
  references: [],
  closure: { paths: [] },
  promptHooks: [],
});

describe('J only documented hook keys per harness', () => {
  const raw = {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            { type: 'command', command: 'run-hook session-start', shell: 'bash', async: false },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'check-git', if: 'Bash(git *)' },
            { type: 'command', command: 'lint', once: true, statusMessage: 'Linting' },
            { type: 'prompt', prompt: 'Is this safe?' },
          ],
        },
      ],
    },
  };

  it('J claude keeps its documented keys (shell and async are Claude keys)', () => {
    const r = convertHooks(hookSet('claude', raw), 'claude', asIs);
    expect(r.hooks).toEqual(raw);
    expect(r.dropped).toEqual([]);
  });

  it('J codex gets only Codex keys; handlers it would run differently are skipped', () => {
    const r = convertHooks(hookSet('claude', raw), 'codex', asIs);
    expect(r.hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'run-hook session-start', async: false }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'lint', statusMessage: 'Linting' }],
          },
        ],
      },
    });
    expect(r.dropped).toEqual([
      'SessionStart: shell (not a Codex hook key)',
      'PreToolUse: hook with if: Bash(git *) (Codex has no if filter)',
      'PreToolUse: once (not a Codex hook key)',
      'PreToolUse: prompt hook (Codex runs command and mcp_tool hooks)',
    ]);
    expect(r.exec.map((e) => e.command)).toEqual(['run-hook session-start', 'lint']);
  });
});

describe('C6 Copilot matchers with arguments', () => {
  it('C6 a matcher with an argument is skipped for copilot with a note', () => {
    const raw = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash(git commit*)', hooks: [{ type: 'command', command: 'pre-commit' }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }] },
        ],
      },
    };
    const r = convertHooks(hookSet('claude', raw), 'copilot', asIs);
    expect(r.dropped).toEqual([
      'PreToolUse: matcher "Bash(git commit*)" has an argument copilot cannot match',
    ]);
    expect(r.exec.map((e) => e.command)).toEqual(['fmt']);
  });
});

describe('Y13 adoption compares meaning, not bytes', () => {
  const rendered = '---\ndescription: TS rules\napplyTo: "**/*.ts"\n---\n\nUse strict.\n';

  async function applyOver(existing: string) {
    const root = await tmpDir();
    const file = '.github/instructions/ts.instructions.md';
    await write(path.join(root, file), existing);
    const target = createTarget('copilot', fakeEnv(root));
    const rendering = {
      files: [{ path: file, data: Buffer.from(rendered) }],
      fragments: [],
      exec: [],
      notes: [],
      hash: 'sha256:0',
    };
    const input = { rendered: rendering, scopeRoot: root, owned: [], force: false, dryRun: false };
    return { root, file, result: target.apply(input) };
  }

  it('Y13 other quoting, key order, CRLF and trailing spaces are adopted and rewritten', async () => {
    const existing =
      "---\r\napplyTo: '**/*.ts'\r\ndescription: TS rules\r\n---\r\nUse strict.   \r\n\r\n";
    const { root, file, result } = await applyOver(existing);
    expect((await result).adopted).toEqual([file]);
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(rendered);
  });

  it('Y13 other words are still a conflict', async () => {
    const { result } = await applyOver(rendered.replace('strict', 'loose'));
    await expect(result).rejects.toThrow(/refusing to overwrite/);
  });

  it('Y13 JSON with the same value is adopted', () => {
    expect(
      sameContent(
        Buffer.from('{"a":1,"b":[2]}'),
        Buffer.from('{\n  "b": [2],\n  "a": 1\n}\n'),
        'x.json',
      ),
    ).toBe(true);
    expect(sameContent(Buffer.from('{"a":1}'), Buffer.from('{"a":2}'), 'x.json')).toBe(false);
  });
});

describe('J14 a Cursor hooks.json palm created goes with its last hook', () => {
  async function cursorHook(existing?: string) {
    const root = await tmpDir();
    const src = await makeSource();
    const hooksJson = path.join(root, '.cursor/hooks.json');
    if (existing !== undefined) await write(hooksJson, existing);
    const k = allKinds(src).find((e) => e.label === 'hook');
    if (!k) throw new Error('no hook fixture');
    const target = createTarget('cursor', fakeEnv(root));
    const done = await install(target, {
      ...k,
      scope: 'project',
      scopeRoot: root,
      sourceRoot: src.root,
    });
    await target.undeploy(done.entry, 'project', root, false);
    return { hooksJson, entry: done.entry };
  }

  it('J14 created by palm: deleted when only version is left', async () => {
    const { hooksJson, entry } = await cursorHook();
    expect(entry.merged?.every((m) => m.created)).toBe(true);
    expect(await exists(hooksJson)).toBe(false);
  });

  it('J14 the person had it: kept, with its version', async () => {
    const { hooksJson, entry } = await cursorHook('{\n  "version": 1\n}\n');
    expect(entry.merged?.some((m) => m.created)).toBe(false);
    expect(JSON.parse(await fs.readFile(hooksJson, 'utf8'))).toEqual({ version: 1 });
  });
});

describe('Y14 same-name agents in a harness directory', () => {
  it('Y14 two files answering to one name are listed for check', async () => {
    const root = await tmpDir();
    const env = fakeEnv(root);
    const agent = (name: string) => `---\nname: ${name}\ndescription: d\n---\nBody\n`;
    await write(path.join(root, '.cursor/agents/worker-agent.md'), agent('worker-agent'));
    await write(path.join(root, '.cursor/agents/new-subagent.md'), agent('worker-agent'));
    await write(path.join(root, '.cursor/agents/solo.md'), agent('solo'));
    const cursor = createTarget('cursor', env);
    expect(await cursor.agentNameClashes('project', root, env)).toEqual([
      {
        name: 'worker-agent',
        files: ['.cursor/agents/new-subagent.md', '.cursor/agents/worker-agent.md'],
      },
    ]);
    await write(path.join(root, '.codex/agents/a.toml'), 'name = "rev"\n');
    await write(path.join(root, '.codex/agents/b.toml'), 'name = "rev"\n');
    const codex = createTarget('codex', env);
    expect((await codex.agentNameClashes('project', root, env))[0]?.name).toBe('rev');
    expect(await createTarget('claude', env).agentNameClashes('project', root, env)).toEqual([]);
  });
});
