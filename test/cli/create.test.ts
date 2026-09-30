/** `palm create` as a template writer (DESIGN.md §10): no prompts, never overwrites. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallRequest, PalmContext } from '../../src/core/types.js';
import { createEntity, templateFor } from '../../src/create/templates.js';
import { createOutput } from '../../src/ui/output.js';
import { exists, read, removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import { fakeEngine, fakeScope, fakeUI, lockEntry, outcome, palm } from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

function context(dryRun = false): PalmContext {
  return {
    paths: { palmHome: sb.palmHome, home: sb.home, projectRoot: sb.project, cwd: sb.project },
    ui: fakeUI(),
    log: createOutput({ stdout: { write: () => 0 }, stderr: { write: () => 0 } }),
    env: sb.env,
    flags: {
      yes: false,
      dryRun,
      force: false,
      offline: false,
      json: false,
      allowExec: [],
      local: false,
    },
  };
}

/** An engine where ./agent-kit is not declared before the install and is after it. */
function creating() {
  const kit = { name: './agent-kit', path: join(sb.project, 'agent-kit') };
  return fakeEngine({
    scopes: [
      fakeScope({ root: sb.project, manifestTargets: ['claude'] }),
      fakeScope({ root: sb.project, manifestTargets: ['claude'], sources: [kit] }),
    ],
    installFromSource: async (_ctx, req: InstallRequest) => ({
      outcomes: req.names.map((n) =>
        outcome(
          lockEntry({
            kind: n.kind ?? 'skill',
            name: n.name,
            source: './agent-kit',
            files: [`.claude/skills/${n.name}/SKILL.md`],
          }),
        ),
      ),
      failures: [],
      warnings: [],
    }),
  });
}

describe('templateFor', () => {
  it('skill: skills/<name>/SKILL.md with name and description frontmatter', () => {
    const [file, ...rest] = templateFor('skill', 'release-notes', 'Write the release notes');
    expect(rest).toEqual([]);
    expect(file?.rel).toBe('skills/release-notes/SKILL.md');
    expect(file?.content).toMatch(
      /^---\nname: release-notes\ndescription: Write the release notes\n---\n\n# Release notes\n/,
    );
  });

  it('agent: agents/<name>.md with frontmatter and a body', () => {
    const [file] = templateFor('agent', 'reviewer', 'Reviews diffs: before a merge');
    expect(file?.rel).toBe('agents/reviewer.md');
    expect(file?.content).toMatch(
      /^---\nname: reviewer\ndescription: "Reviews diffs: before a merge"\n---\n\nYou are Reviewer\./,
    );
  });

  it('instruction: instructions/<name>.md with a description', () => {
    const [file] = templateFor('instruction', 'db-conventions');
    expect(file?.rel).toBe('instructions/db-conventions.md');
    expect(file?.content).toMatch(
      /^---\ndescription: Describe what db-conventions covers\.\n---\n/,
    );
  });

  it('hook: hooks/<name>/hooks.json with one SessionStart command and its script, mode 755', () => {
    const [json, script] = templateFor('hook', 'session-log');
    expect(json?.rel).toBe('hooks/session-log/hooks.json');
    expect(JSON.parse(json?.content ?? '')).toEqual({
      description: 'session-log: runs when a session starts.',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-log.sh"',
              },
            ],
          },
        ],
      },
    });
    expect(script).toMatchObject({ rel: 'hooks/session-log/scripts/session-log.sh', mode: 0o755 });
    expect(script?.content.startsWith('#!/usr/bin/env bash\n')).toBe(true);
  });
});

describe('createEntity', () => {
  it.each([
    ['skill', 'skills/notes/SKILL.md'],
    ['agent', 'agents/notes.md'],
    ['instruction', 'instructions/notes.md'],
    ['hook', 'hooks/notes/hooks.json'],
  ] as const)('writes the %s template into ./agent-kit and installs it', async (kind, rel) => {
    const deps = creating();
    const created = await createEntity(context(), { kind, name: 'notes', scope: 'project' }, deps);
    const file = join(sb.project, 'agent-kit', rel);
    expect(created.file).toBe(file);
    expect(await read(file)).toBe(templateFor(kind, 'notes')[0]?.content);
    expect(created.declared).toBe(true);
    expect(created.source?.name).toBe('./agent-kit');
    expect(deps.calls.installFromSource?.[0]?.[0]).toEqual({
      source: join(sb.project, 'agent-kit'),
      names: [{ kind, name: 'notes' }],
    });
  });

  it('gives the hook script mode 755', async () => {
    await createEntity(context(), { kind: 'hook', name: 'notes', scope: 'project' }, creating());
    const script = join(sb.project, 'agent-kit/hooks/notes/scripts/notes.sh');
    expect((await stat(script)).mode & 0o777).toBe(0o755);
  });

  it('refuses an existing file with E_CONFLICT and writes nothing', async () => {
    const file = join(sb.project, 'agent-kit/skills/notes/SKILL.md');
    await write(file, 'mine\n');
    const deps = creating();
    await expect(
      createEntity(context(), { kind: 'skill', name: 'notes', scope: 'project' }, deps),
    ).rejects.toMatchObject({
      code: 'E_CONFLICT',
      hint: 'install the one that is there: palm install ./agent-kit skill:notes',
    });
    expect(await read(file)).toBe('mine\n');
    expect(deps.calls.installFromSource).toBeUndefined();
  });

  it('refuses a name that is not one path segment', async () => {
    await expect(
      createEntity(context(), { kind: 'skill', name: '../x', scope: 'project' }, creating()),
    ).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('writes into --in and, under -g, ~/.palm/kit', async () => {
    await createEntity(
      context(),
      { kind: 'agent', name: 'a', dir: 'tools/kit', scope: 'project' },
      creating(),
    );
    expect(await exists(join(sb.project, 'tools/kit/agents/a.md'))).toBe(true);
    await createEntity(context(), { kind: 'agent', name: 'b', scope: 'global' }, creating());
    expect(await exists(join(sb.palmHome, 'kit/agents/b.md'))).toBe(true);
  });

  it('a dry run writes and installs nothing', async () => {
    const deps = creating();
    const created = await createEntity(
      context(true),
      { kind: 'skill', name: 'n', scope: 'project' },
      deps,
    );
    expect(await exists(created.file)).toBe(false);
    expect(deps.calls.installFromSource).toBeUndefined();
  });
});

describe('palm create', () => {
  it('prints what it wrote, the declared source and the install', async () => {
    const r = await palm(sb, ['create', 'skill', 'notes'], { deps: creating() });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '+ wrote agent-kit/skills/notes/SKILL.md',
        '+ source ./agent-kit → palm.yaml',
        '+ skill  notes   .claude/skills/notes/   1 file',
        '1 installed. Commit palm.yaml, palm.lock.yaml, agent-kit/ and .claude/ together.',
        'edit agent-kit/skills/notes/SKILL.md; palm install renders the change',
        '',
      ].join('\n'),
    );
  });

  it('a command is a skill', async () => {
    const r = await palm(sb, ['create', 'command', 'changelog']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x a command installs as a skill; palm create writes skills\n  palm create skill changelog\n',
    );
  });

  it('plugins and MCP servers are not templates', async () => {
    const r = await palm(sb, ['create', 'mcp', 'docs']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('palm create writes a skill, agent, instruction or hook, not "mcp"');
  });
});
