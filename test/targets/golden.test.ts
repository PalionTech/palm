/**
 * Golden round trip: deploying entities into a scope and undeploying them again leaves every
 * file byte-identical (content and mode) and no directory behind. The scope already uses
 * each harness (user settings, a user MCP server, a user skill, a hook palm manages), so the
 * shared files palm merges into exist before and after.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(cleanupTmp);

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
    expect(deployed.map((d) => d.result.skipped ?? false)).toEqual([false, false, false]);
    expect(await snapshot(root)).not.toEqual(before);

    for (const { entity, result } of deployed)
      await target.undeploy(mkLock(entity, [id], result.files, result.merged), scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});
