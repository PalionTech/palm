/**
 * Golden round trip: deploying entities into a scope and undeploying them again leaves every
 * file byte-identical (content and mode) and no directory behind. The scope already uses
 * each harness (user settings, a user MCP server, a user skill, a hook palm manages), so the
 * shared files palm merges into exist before and after.
 *
 * Failed deploys: a write that fails after the Writer applied the merge (injected through a
 * fake `writeFileAtomic` error) rolls the merge back too, so the scope is byte-identical.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entity, Scope, TargetId } from '../../src/core/types.js';
import { TARGET_IDS } from '../../src/core/types.js';
import { stringifyJson } from '../../src/lib/json.js';
import { createTarget } from '../../src/targets/index.js';
import {
  CLAUDE_HOOKS,
  cleanupTmp,
  fakeEnv,
  makeOrigin,
  mkEntity,
  mkInput,
  mkLock,
  tmpDir,
  write,
} from './helpers.js';

/** Fault injection for `writeFileAtomic`: writes matching `failOn` throw EIO; every call is logged. */
const io = vi.hoisted(() => ({
  failOn: undefined as ((file: string) => boolean) | undefined,
  written: [] as string[],
}));

vi.mock('../../src/lib/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/fs.js')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      const [file] = args;
      if (io.failOn?.(file))
        throw Object.assign(new Error(`EIO: injected failure writing ${file}`), { code: 'EIO' });
      io.written.push(file);
      return actual.writeFileAtomic(...args);
    },
  };
});

afterEach(async () => {
  io.failOn = undefined;
  io.written = [];
  await cleanupTmp();
});

const MINE = { command: 'mine', args: ['--flag'] };

/** What a scope looks like when the user already works with every harness. */
const SEED: Record<Scope, Record<string, string>> = {
  project: {
    'palm.yaml': 'skills: []\n',
    '.claude/settings.json': stringifyJson({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }),
    '.mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.codex/config.toml': '# my codex config\nmodel = "gpt-6-astra" # favourite\n',
    '.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: mine\n---\n',
    '.github/copilot-instructions.md': '# House rules\n',
    '.vscode/mcp.json': stringifyJson({ servers: { mine: MINE } }),
    '.cursor/hooks.json': stringifyJson({ version: 1 }),
    '.cursor/mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    'GEMINI.md': '# Gemini rules\n\nBe brief.\n',
    '.gemini/settings.json': stringifyJson({ ui: { theme: 'GitHub' }, mcpServers: { mine: MINE } }),
    'opencode.json': stringifyJson({
      $schema: 'https://opencode.ai/config.json',
      instructions: ['CONTRIBUTING.md'],
      mcp: { mine: { type: 'local', command: ['mine', '--flag'] } },
    }),
    '.opencode/agents/mine.md': '---\ndescription: mine\n---\n',
    '.palm/hooks/other/run.sh': '#!/bin/sh\n',
  },
  global: {
    '.claude/settings.json': stringifyJson({ theme: 'dark' }),
    '.claude.json': stringifyJson({ numStartups: 3, mcpServers: { mine: MINE } }),
    '.codex/config.toml': 'model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n',
    '.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: mine\n---\n',
    '.copilot/mcp-config.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.cursor/hooks.json': stringifyJson({ version: 1 }),
    '.cursor/mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.gemini/GEMINI.md': '# Mine\n',
    '.gemini/settings.json': stringifyJson({
      hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    }),
    '.config/opencode/opencode.json': stringifyJson({ instructions: ['/abs/mine.md'] }),
    '.config/opencode/agents/mine.md': '---\ndescription: mine\n---\n',
    '.palm/palm.yaml': 'skills: []\n',
    '.palm/hooks/other/run.sh': '#!/bin/sh\n',
  },
};

/** Every directory (`dir/`) and file (`mode bytes`) below `root`, sorted. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await walk(abs);
      } else {
        const mode = ((await fs.lstat(abs)).mode & 0o777).toString(8);
        out[rel] = `${mode} ${(await fs.readFile(abs)).toString('base64')}`;
      }
    }
  };
  await walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function entities(): Promise<{
  entities: Array<{ entity: Entity; absPath: string }>;
  originRoot: string;
}> {
  const origin = await makeOrigin();
  return {
    originRoot: origin.root,
    entities: [
      {
        entity: mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'Demo skill' } }),
        absPath: origin.skillDir,
      },
      {
        entity: mkEntity(
          {
            kind: 'hook',
            hooks: {
              name: 'fmt',
              dialect: 'claude',
              raw: CLAUDE_HOOKS,
              pluginRootRel: 'plugins/fmt',
            },
          },
          'fmt',
        ),
        absPath: origin.hooksFile,
      },
      {
        entity: mkEntity(
          {
            kind: 'mcp',
            mcp: {
              name: 'gh',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', 'gh-mcp'],
              env: { GH_TOKEN: '${GH_TOKEN}' },
            },
          },
          'gh',
        ),
        absPath: path.join(origin.root, '.mcp.json'),
      },
    ],
  };
}

describe.each(
  TARGET_IDS.flatMap((t) => (['project', 'global'] as const).map((s) => [t, s] as const)),
)('golden round trip: %s @ %s', (id: TargetId, scope: Scope) => {
  it('deploy then undeploy of a skill, a hook and an MCP server restores the scope byte for byte', async () => {
    const root = await tmpDir();
    for (const [rel, content] of Object.entries(SEED[scope]))
      await write(path.join(root, ...rel.split('/')), content);
    const before = await snapshot(root);
    const env = fakeEnv(root);
    const target = createTarget(id, env);
    const { entities: list, originRoot } = await entities();

    const deployed = [];
    for (const e of list) {
      const r = await target.deploy(mkInput({ ...e, originRoot, scope, scopeRoot: root }));
      deployed.push({ entity: e.entity, result: r });
    }
    // OpenCode has no declarative hooks: the hook is skipped, the rest is deployed.
    expect(deployed.map((d) => d.result.skipped ?? false)).toEqual([
      false,
      id === 'opencode',
      false,
    ]);
    expect(await snapshot(root)).not.toEqual(before);

    for (const { entity, result } of deployed)
      await target.undeploy(mkLock(entity, [id], result.files, result.merged), scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});

const AGENT = {
  name: 'demo',
  description: 'Demo agent',
  model: 'sonnet',
  tools: ['Read', 'Bash', 'mcp__gh__search'],
  skills: ['demo'],
  mcpServers: ['gh'],
  body: 'Be helpful.\n',
};

/** Every kind: the new targets' instruction mechanisms (GEMINI.md block, opencode.json list). */
function allKinds(origin: string, base: Array<{ entity: Entity; absPath: string }>) {
  const file = (rel: string) => path.join(origin, rel);
  return [
    ...base,
    { entity: mkEntity({ kind: 'agent', agent: AGENT }), absPath: file('agents/demo.md') },
    {
      entity: mkEntity({
        kind: 'instruction',
        instruction: { name: 'demo', globs: ['src/**'], alwaysApply: false, body: 'Strict.\n' },
      }),
      absPath: file('rules/demo.md'),
    },
    {
      entity: mkEntity({
        kind: 'command',
        command: { name: 'demo', description: 'Demo', body: 'Run $ARGUMENTS\n' },
      }),
      absPath: file('commands/demo.md'),
    },
  ];
}

describe.each(
  (['gemini', 'opencode'] as const).flatMap((t) =>
    (['project', 'global'] as const).map((s) => [t, s] as const),
  ),
)('golden round trip, every kind: %s @ %s', (id: TargetId, scope: Scope) => {
  it('deploy then undeploy leaves user GEMINI.md / settings.json / opencode.json byte-identical', async () => {
    const root = await tmpDir();
    for (const [rel, content] of Object.entries(SEED[scope]))
      await write(path.join(root, ...rel.split('/')), content);
    const before = await snapshot(root);
    const target = createTarget(id, fakeEnv(root));
    const { entities: base, originRoot } = await entities();

    const deployed = [];
    for (const e of allKinds(originRoot, base)) {
      const r = await target.deploy(mkInput({ ...e, originRoot, scope, scopeRoot: root }));
      deployed.push({ entity: e.entity, result: r });
    }
    const merged = deployed.flatMap((d) => d.result.merged ?? []).map((m) => m.pointer);
    if (id === 'gemini') expect(merged).toContain('block:instruction:demo');
    else expect(merged).toContain('/instructions');
    expect(await snapshot(root)).not.toEqual(before);

    for (const { entity, result } of deployed.reverse())
      await target.undeploy(mkLock(entity, [id], result.files, result.merged), scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});

/** The shared hooks file each harness merges into (copilot writes standalone files instead). */
const HOOK_MERGE_FILE: Record<TargetId, Record<Scope, string | undefined>> = {
  claude: { project: '.claude/settings.json', global: '.claude/settings.json' },
  codex: { project: '.codex/hooks.json', global: '.codex/hooks.json' },
  copilot: { project: undefined, global: undefined },
  cursor: { project: '.cursor/hooks.json', global: '.cursor/hooks.json' },
  gemini: { project: '.gemini/settings.json', global: '.gemini/settings.json' },
  opencode: { project: undefined, global: undefined },
};

describe.each(
  TARGET_IDS.flatMap((t) => (['project', 'global'] as const).map((s) => [t, s] as const)),
)('failed deploy: %s @ %s', (id: TargetId, scope: Scope) => {
  it('a write failing after the merge step leaves the scope byte-identical', async () => {
    const root = await tmpDir();
    for (const [rel, content] of Object.entries(SEED[scope]))
      await write(path.join(root, ...rel.split('/')), content);
    const before = await snapshot(root);
    const target = createTarget(id, fakeEnv(root));
    const { entities: list, originRoot } = await entities();
    const hook = list.find((e) => e.entity.kind === 'hook')!;

    // The hook's scripts are copied after its entries were merged into the shared hooks file.
    const assets = path.join(root, '.palm', 'hooks', 'fmt');
    io.failOn = (file) => file.startsWith(`${assets}${path.sep}`);
    const deploying = target.deploy(mkInput({ ...hook, originRoot, scope, scopeRoot: root }));
    if (id === 'opencode') await expect(deploying).resolves.toMatchObject({ skipped: true });
    else await expect(deploying).rejects.toThrow(/injected failure/);

    const merged = HOOK_MERGE_FILE[id][scope];
    if (merged) expect(io.written).toContain(path.join(root, merged)); // the merge was applied
    expect(await snapshot(root)).toEqual(before);
  });

  it('an MCP merge that fails leaves the scope byte-identical, and a retry succeeds', async () => {
    const root = await tmpDir();
    for (const [rel, content] of Object.entries(SEED[scope]))
      await write(path.join(root, ...rel.split('/')), content);
    const before = await snapshot(root);
    const target = createTarget(id, fakeEnv(root));
    const { entities: list, originRoot } = await entities();
    const mcp = list.find((e) => e.entity.kind === 'mcp')!;
    const input = mkInput({ ...mcp, originRoot, scope, scopeRoot: root });

    io.failOn = () => true;
    await expect(target.deploy(input)).rejects.toThrow(/injected failure/);
    expect(await snapshot(root)).toEqual(before);
    io.failOn = undefined;
    const r = await target.deploy(input);
    await target.undeploy(mkLock(mcp.entity, [id], r.files, r.merged), scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});
