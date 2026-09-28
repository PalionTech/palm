import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DeployResult,
  Entity,
  LockEntry,
  MergedRecord,
  Scope,
  TargetId,
} from '../../src/core/types.js';
import { TARGET_IDS } from '../../src/core/types.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { renderAgent } from '../../src/targets/convert-agent.js';
import { renderCommand } from '../../src/targets/convert-command.js';
import { convertHooks, PROJECT_DIR } from '../../src/targets/convert-hooks.js';
import { renderInstruction } from '../../src/targets/convert-instruction.js';
import { allTargets, createTarget, getTarget } from '../../src/targets/index.js';
import {
  CLAUDE_HOOKS,
  cleanupTmp,
  exists,
  fakeEnv,
  makeOrigin,
  mkEntity,
  mkInput,
  mkLock,
  RUN_SH,
  read,
  readJson,
  SKILL_MD,
  tmpDir,
  write,
} from './helpers.js';

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmp();
});

const AGENT_DEF = {
  name: 'demo',
  description: 'Demo agent',
  model: 'sonnet',
  tools: ['Read', 'Grep'],
  skills: ['demo'],
  body: 'Be helpful.\n',
};
const INSTR_DEF = {
  name: 'demo',
  description: 'TS rules',
  globs: ['src/**/*.ts'],
  alwaysApply: false,
  body: 'Use strict.\n',
};
const CMD_DEF = {
  name: 'demo',
  description: 'Run the demo',
  argumentHint: '[x]',
  body: 'Demo $ARGUMENTS\n',
};
const MCP_DEF = {
  name: 'gh',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', 'gh-mcp'],
  env: { GH_TOKEN: '${GH_TOKEN}' },
};

type Origin = Awaited<ReturnType<typeof makeOrigin>>;

function entities(origin: Origin) {
  return {
    skill: {
      entity: mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'Demo skill' } }),
      absPath: origin.skillDir,
    },
    agent: {
      entity: mkEntity({ kind: 'agent', agent: AGENT_DEF }),
      absPath: path.join(origin.root, 'agents', 'demo.md'),
    },
    instruction: {
      entity: mkEntity({ kind: 'instruction', instruction: INSTR_DEF }),
      absPath: path.join(origin.root, 'rules', 'demo.md'),
    },
    command: {
      entity: mkEntity({ kind: 'command', command: CMD_DEF }),
      absPath: path.join(origin.root, 'commands', 'demo.md'),
    },
    hook: {
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
    mcp: {
      entity: mkEntity({ kind: 'mcp', mcp: MCP_DEF }, 'gh'),
      absPath: path.join(origin.root, '.mcp.json'),
    },
  };
}

interface Expect {
  skill: string;
  agent: string;
  /** The instruction file (or the file holding its block); null when skipped. */
  instruction: string | null;
  command: string | null;
  /** The shared hooks file (copilot: the standalone file); null when hooks are skipped. */
  hookFile: string | null;
  mcpFile: string;
  /** OpenCode: the config whose `instructions` array lists the instruction file. */
  instructionList?: string;
}

/** Targets that keep instructions as managed blocks in a shared markdown file. */
const BLOCK_INSTRUCTIONS: readonly TargetId[] = ['codex', 'gemini'];

/** Paths relative to scopeRoot (project) or home (global, no env overrides). */
const PATHS: Record<TargetId, Record<Scope, Expect>> = {
  claude: {
    project: {
      skill: '.claude/skills/demo',
      agent: '.claude/agents/demo.md',
      instruction: '.claude/rules/demo.md',
      command: '.claude/commands/demo.md',
      hookFile: '.claude/settings.json',
      mcpFile: '.mcp.json',
    },
    global: {
      skill: '.claude/skills/demo',
      agent: '.claude/agents/demo.md',
      instruction: '.claude/rules/demo.md',
      command: '.claude/commands/demo.md',
      hookFile: '.claude/settings.json',
      mcpFile: '.claude.json',
    },
  },
  codex: {
    project: {
      skill: '.agents/skills/demo',
      agent: '.codex/agents/demo.toml',
      instruction: 'AGENTS.md',
      command: null,
      hookFile: '.codex/hooks.json',
      mcpFile: '.codex/config.toml',
    },
    global: {
      skill: '.agents/skills/demo',
      agent: '.codex/agents/demo.toml',
      instruction: '.codex/AGENTS.md',
      command: '.codex/prompts/demo.md',
      hookFile: '.codex/hooks.json',
      mcpFile: '.codex/config.toml',
    },
  },
  copilot: {
    project: {
      skill: '.agents/skills/demo',
      agent: '.github/agents/demo.agent.md',
      instruction: '.github/instructions/demo.instructions.md',
      command: '.github/prompts/demo.prompt.md',
      hookFile: '.github/hooks/fmt.json',
      mcpFile: '.vscode/mcp.json',
    },
    global: {
      skill: '.agents/skills/demo',
      agent: '.copilot/agents/demo.agent.md',
      instruction: '.copilot/instructions/demo.instructions.md',
      command: null,
      hookFile: '.copilot/hooks/fmt.json',
      mcpFile: '.copilot/mcp-config.json',
    },
  },
  cursor: {
    project: {
      skill: '.agents/skills/demo',
      agent: '.cursor/agents/demo.md',
      instruction: '.cursor/rules/demo.mdc',
      command: '.cursor/commands/demo.md',
      hookFile: '.cursor/hooks.json',
      mcpFile: '.cursor/mcp.json',
    },
    global: {
      skill: '.agents/skills/demo',
      agent: '.cursor/agents/demo.md',
      instruction: null,
      command: '.cursor/commands/demo.md',
      hookFile: '.cursor/hooks.json',
      mcpFile: '.cursor/mcp.json',
    },
  },
  gemini: {
    project: {
      skill: '.agents/skills/demo',
      agent: '.gemini/agents/demo.md',
      instruction: 'GEMINI.md',
      command: '.gemini/commands/demo.toml',
      hookFile: '.gemini/settings.json',
      mcpFile: '.gemini/settings.json',
    },
    global: {
      skill: '.agents/skills/demo',
      agent: '.gemini/agents/demo.md',
      instruction: '.gemini/GEMINI.md',
      command: '.gemini/commands/demo.toml',
      hookFile: '.gemini/settings.json',
      mcpFile: '.gemini/settings.json',
    },
  },
  opencode: {
    project: {
      skill: '.agents/skills/demo',
      agent: '.opencode/agents/demo.md',
      instruction: '.opencode/instructions/demo.md',
      instructionList: 'opencode.json',
      command: '.opencode/commands/demo.md',
      hookFile: null,
      mcpFile: 'opencode.json',
    },
    global: {
      skill: '.agents/skills/demo',
      agent: '.config/opencode/agents/demo.md',
      instruction: '.config/opencode/instructions/demo.md',
      instructionList: '.config/opencode/opencode.json',
      command: '.config/opencode/commands/demo.md',
      hookFile: null,
      mcpFile: '.config/opencode/opencode.json',
    },
  },
};

const ASSET_FILES = ['.claude-plugin/plugin.json', 'hooks/format.sh', 'hooks/hooks.json'];

/** The key holding MCP servers in a target's JSON config. */
function mcpKey(target: TargetId, scope: Scope): string {
  if (target === 'opencode') return 'mcp';
  return target === 'copilot' && scope === 'project' ? 'servers' : 'mcpServers';
}

function mcpPointer(target: TargetId, scope: Scope): string {
  return target === 'codex' ? '/mcp_servers/gh' : `/${mcpKey(target, scope)}/gh`;
}

describe.each(
  TARGET_IDS.flatMap((t) => (['project', 'global'] as const).map((s) => [t, s] as const)),
)('%s @ %s', (id, scope) => {
  it('deploys every kind to the documented location, idempotently, and undeploys cleanly', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const env = fakeEnv(root);
    const target = createTarget(id, env);
    const P = PATHS[id][scope];
    const shown = (rel: string): string => (scope === 'project' ? rel : path.join(root, rel));
    const abs = (rel: string): string => path.join(root, rel);
    const E = entities(origin);
    const deploy = (e: { entity: Entity; absPath: string }): Promise<DeployResult> =>
      target.deploy(mkInput({ ...e, originRoot: origin.root, scope, scopeRoot: root }));
    const results: Array<{ entity: Entity; result: DeployResult }> = [];

    // skill
    const skill = await deploy(E.skill);
    expect(skill.files).toEqual(
      ['SKILL.md', 'references/notes.md', 'scripts/run.sh'].map((f) => shown(`${P.skill}/${f}`)),
    );
    expect(await read(abs(`${P.skill}/SKILL.md`))).toBe(SKILL_MD);
    expect(await read(abs(`${P.skill}/scripts/run.sh`))).toBe(RUN_SH);
    expect((await fs.stat(abs(`${P.skill}/scripts/run.sh`))).mode & 0o777).toBe(0o755);
    for (const junk of ['node_modules', '.git', 'bundle.zip'])
      expect(await exists(abs(`${P.skill}/${junk}`))).toBe(false);
    results.push({ entity: E.skill.entity, result: skill });

    // agent
    const agent = await deploy(E.agent);
    expect(agent.files).toEqual([shown(P.agent)]);
    expect(await read(abs(P.agent))).toBe(renderAgent(AGENT_DEF, id).content);
    if (id !== 'claude') expect(agent.notes.join('\n')).toMatch(/dropped/);
    results.push({ entity: E.agent.entity, result: agent });

    // instruction
    const instr = await deploy(E.instruction);
    if (P.instruction === null) {
      expect(instr).toMatchObject({ files: [], skipped: true });
      expect(instr.notes[0]).toMatch(/Cursor Settings/);
    } else if (BLOCK_INSTRUCTIONS.includes(id)) {
      const block = (renderInstruction(INSTR_DEF, id) as { managedBlock: string }).managedBlock;
      expect(instr.files).toEqual([]);
      expect(instr.merged).toEqual([
        { file: shown(P.instruction), pointer: 'block:instruction:demo', value: block },
      ]);
      expect(await read(abs(P.instruction))).toBe(
        `<!-- palm:begin instruction:demo -->\n${block}<!-- palm:end instruction:demo -->\n`,
      );
    } else {
      expect(instr.files).toEqual([shown(P.instruction)]);
      expect(await read(abs(P.instruction))).toBe(
        (renderInstruction(INSTR_DEF, id) as { content: string }).content,
      );
      if (P.instructionList) {
        // project: the relative path OpenCode globs upward for; global: an absolute path
        const listed = shown(P.instruction);
        expect(instr.merged).toEqual([
          { file: shown(P.instructionList), pointer: '/instructions', value: listed },
        ]);
        expect(await readJson(abs(P.instructionList))).toEqual({ instructions: [listed] });
      } else expect(instr.merged).toEqual([]);
    }
    results.push({ entity: E.instruction.entity, result: instr });

    // command
    const cmd = await deploy(E.command);
    if (P.command === null) {
      expect(cmd).toMatchObject({ files: [], skipped: true });
      expect(cmd.notes).toHaveLength(1);
    } else {
      expect(cmd.files).toEqual([shown(P.command)]);
      expect(await read(abs(P.command))).toBe(renderCommand(CMD_DEF, id).content);
    }
    results.push({ entity: E.command.entity, result: cmd });

    // hook
    const assetRel = '.palm/hooks/fmt';
    const hook = await deploy(E.hook);
    results.push({ entity: E.hook.entity, result: hook });
    const hookFile = P.hookFile;
    if (hookFile === null) {
      expect(hook).toEqual({
        files: [],
        merged: [],
        notes: ['hooks fmt: OpenCode hooks are JS plugins; not installed'],
        skipped: true,
      });
      expect(await exists(abs(assetRel))).toBe(false);
    } else {
      const converted = convertHooks(
        E.hook.entity.def.kind === 'hook' ? E.hook.entity.def.hooks : (undefined as never),
        id,
        abs(assetRel),
        ScopePaths.at(scope, root, env),
      ).hooks as { hooks: Record<string, unknown[]> };
      for (const f of ASSET_FILES) expect(hook.files).toContain(shown(`${assetRel}/${f}`));
      // Hook scripts may read plugin files (superpowers' session-start reads skills/*/SKILL.md): those are
      // copied; docs, tests and top-level READMEs are not.
      expect(hook.files).toContain(shown(`${assetRel}/skills/s/SKILL.md`));
      for (const skipped of ['docs', 'tests', 'README.md'])
        expect(await exists(abs(`${assetRel}/${skipped}`))).toBe(false);
      expect((await fs.stat(abs(`${assetRel}/hooks/format.sh`))).mode & 0o777).toBe(0o755);
      if (id === 'copilot') {
        expect(hook.files).toContain(shown(hookFile));
        expect(await read(abs(hookFile))).toBe(`${JSON.stringify(converted, null, 2)}\n`);
        expect(hook.merged).toEqual([]);
      } else {
        expect(hook.merged?.map((m) => [m.file, m.pointer])).toEqual(
          Object.keys(converted.hooks).map((ev) => [shown(hookFile), `/hooks/${ev}`]),
        );
        const onDisk = (await readJson(abs(hookFile))) as Record<string, unknown>;
        expect(onDisk.hooks).toEqual(converted.hooks);
        if (id === 'cursor') expect(onDisk.version).toBe(1);
      }
      const cmdText = JSON.stringify(converted);
      // Project configs are committed: the command names the project root through the harness,
      // never as an absolute path; global configs use the absolute asset dir.
      if (scope === 'project') {
        expect(cmdText).toContain(`${PROJECT_DIR[id]}/.palm/hooks/fmt/hooks/format.sh`);
        expect(cmdText).not.toContain(root);
      } else expect(cmdText).toContain(`${abs(assetRel)}/hooks/format.sh`);
    }

    // mcp
    const mcp = await deploy(E.mcp);
    expect(mcp.files).toEqual([]);
    expect(mcp.merged).toHaveLength(1);
    expect(mcp.merged![0]!.file).toBe(shown(P.mcpFile));
    expect(mcp.merged![0]!.pointer).toBe(mcpPointer(id, scope));
    expect(mcp.notes.join('\n')).toContain('GH_TOKEN');
    if (id === 'codex') {
      expect(parseToml(await read(abs(P.mcpFile)))).toEqual({
        mcp_servers: { gh: { command: 'npx', args: ['-y', 'gh-mcp'], env_vars: ['GH_TOKEN'] } },
      });
    } else {
      const doc = await readJson(abs(P.mcpFile));
      expect((doc as Record<string, Record<string, unknown>>)[mcpKey(id, scope)]!.gh).toEqual(
        mcp.merged![0]!.value,
      );
    }
    results.push({ entity: E.mcp.entity, result: mcp });

    // idempotent re-deploy: same result, nothing rewritten
    const old = new Date('2020-01-01T00:00:00Z');
    const allFiles = results.flatMap((r) => [
      ...r.result.files,
      ...(r.result.merged ?? []).map((m) => m.file),
    ]);
    for (const f of new Set(allFiles)) await fs.utimes(scope === 'project' ? abs(f) : f, old, old);
    for (const [kind, e] of Object.entries(E)) {
      const again = await deploy(e);
      const first = results.find((r) => r.entity.kind === kind)!.result;
      expect(again).toEqual(first);
    }
    for (const f of new Set(allFiles))
      expect((await fs.stat(scope === 'project' ? abs(f) : f)).mtime.getTime()).toBe(old.getTime());

    // undeploy
    for (const { entity, result } of results) {
      await target.undeploy(mkLock(entity, [id], result.files, result.merged), scope, root, false);
    }
    for (const f of allFiles.filter(
      (f) => !results.some((r) => r.result.merged?.some((m) => m.file === f)),
    )) {
      expect(await exists(scope === 'project' ? abs(f) : f)).toBe(false);
    }
    expect(await exists(abs(P.skill))).toBe(false);
    expect(await exists(abs(assetRel))).toBe(false);
    if (BLOCK_INSTRUCTIONS.includes(id)) expect(await exists(abs(P.instruction!))).toBe(false);
    if (P.instructionList) expect(await exists(abs(P.instructionList))).toBe(false);
    if (P.hookFile !== null && id !== 'copilot') {
      // Emptied event lists and the `hooks` object are pruned; a file palm alone wrote is deleted
      // (cursor keeps the `version` key palm ensured, so its file stays).
      expect(await exists(abs(P.hookFile))).toBe(id === 'cursor');
      if (id === 'cursor') expect(await readJson(abs(P.hookFile))).toEqual({ version: 1 });
    }
    if (id === 'codex') expect(parseToml(await read(abs(P.mcpFile)))).toEqual({});
    else expect(await exists(abs(P.mcpFile))).toBe(false);
    // the harness config dir itself survives
    expect(await exists(target.configDir(scope, root, env))).toBe(true);
  });
});

describe('collision policy', () => {
  it('refuses to overwrite a foreign file; --force and ownership allow it', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const t = createTarget('claude', fakeEnv(root));
    const { agent } = entities(origin);
    await write(path.join(root, '.claude/agents/demo.md'), 'user agent\n');
    const input = mkInput({ ...agent, scopeRoot: root });
    await expect(t.deploy(input)).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: 'refusing to overwrite .claude/agents/demo.md',
      hint: 'rerun with --force',
    });
    expect(await read(path.join(root, '.claude/agents/demo.md'))).toBe('user agent\n');
    await t.deploy({ ...input, ownedFiles: ['.claude/agents/demo.md'] });
    expect(await read(path.join(root, '.claude/agents/demo.md'))).toBe(
      renderAgent(AGENT_DEF, 'claude').content,
    );
    await write(path.join(root, '.claude/agents/demo.md'), 'user agent\n');
    await t.deploy({ ...input, force: true });
    expect(await read(path.join(root, '.claude/agents/demo.md'))).toBe(
      renderAgent(AGENT_DEF, 'claude').content,
    );
  });

  it('checks all files before writing any (no partial skill install)', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    await write(path.join(root, '.claude/skills/demo/scripts/run.sh'), 'foreign\n');
    await expect(
      createTarget('claude', fakeEnv(root)).deploy(
        mkInput({ ...entities(origin).skill, scopeRoot: root }),
      ),
    ).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
    expect(await exists(path.join(root, '.claude/skills/demo/SKILL.md'))).toBe(false);
  });

  it('merged MCP key: conflict unless forced or owned (file#pointer)', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    await write(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'mine' } } }),
    );
    const t = createTarget('claude', fakeEnv(root));
    const input = mkInput({ ...entities(origin).mcp, scopeRoot: root });
    await expect(t.deploy(input)).rejects.toMatchObject({ code: 'E_CONFLICT' });
    const r = await t.deploy({ ...input, ownedFiles: ['.mcp.json#/mcpServers/gh'] });
    expect(r.merged).toEqual([
      {
        file: '.mcp.json',
        pointer: '/mcpServers/gh',
        value: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'gh-mcp'],
          env: { GH_TOKEN: '${GH_TOKEN}' },
        },
      },
    ]);
    await write(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'mine' } } }),
    );
    await t.deploy({ ...input, force: true });
    expect(await readJson(path.join(root, '.mcp.json'))).toEqual({
      mcpServers: { gh: r.merged![0]!.value },
    });
  });

  it('codex TOML table and AGENTS.md block conflicts', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const t = createTarget('codex', fakeEnv(root));
    await write(path.join(root, '.codex/config.toml'), '[mcp_servers.gh]\ncommand = "mine"\n');
    await expect(
      t.deploy(mkInput({ ...entities(origin).mcp, scopeRoot: root })),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await write(
      path.join(root, 'AGENTS.md'),
      '<!-- palm:begin instruction:demo -->\nother\n<!-- palm:end instruction:demo -->\n',
    );
    await expect(
      t.deploy(mkInput({ ...entities(origin).instruction, scopeRoot: root })),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await t.deploy(
      mkInput({ ...entities(origin).instruction, scopeRoot: root, ownedFiles: ['AGENTS.md'] }),
    );
    expect(await read(path.join(root, 'AGENTS.md'))).toContain('Use strict.');
  });
});

describe('shared .agents/skills', () => {
  it('is written once for codex + copilot + cursor and removed by whichever undeploys first', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const env = fakeEnv(root);
    const { skill } = entities(origin);
    const results = [];
    for (const id of ['codex', 'copilot', 'cursor'] as const)
      results.push(await createTarget(id, env).deploy(mkInput({ ...skill, scopeRoot: root })));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const claude = await createTarget('claude', env).deploy(mkInput({ ...skill, scopeRoot: root }));
    const lock = mkLock(
      skill.entity,
      ['claude', 'codex', 'copilot', 'cursor'],
      [...claude.files, ...results[0]!.files],
    );
    await createTarget('codex', env).undeploy(lock, 'project', root, false);
    expect(await exists(path.join(root, '.agents/skills/demo'))).toBe(false);
    expect(await exists(path.join(root, '.agents'))).toBe(true);
    expect(await exists(path.join(root, '.claude/skills/demo/SKILL.md'))).toBe(true); // not codex's file
    await createTarget('copilot', env).undeploy(lock, 'project', root, false);
    await createTarget('cursor', env).undeploy(lock, 'project', root, false);
    await createTarget('claude', env).undeploy(lock, 'project', root, false);
    expect(await exists(path.join(root, '.claude/skills'))).toBe(false);
    expect(await exists(path.join(root, '.claude'))).toBe(true);
  });
});

describe('hook assets', () => {
  it('undeploy removes only the asset files the lock entry lists, then the emptied dirs', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const target = createTarget('claude', fakeEnv(root));
    const { hook } = entities(origin);
    const r = await target.deploy(mkInput({ ...hook, originRoot: origin.root, scopeRoot: root }));
    const assets = path.join(root, '.palm/hooks/fmt');
    // A file the entry does not list (the user's, or a newer install's) stays.
    await write(path.join(assets, 'hooks/local.sh'), 'mine');
    const listed = r.files.filter((f) => f.startsWith('.palm/'));
    const [kept, ...gone] = listed;
    await target.undeploy(mkLock(hook.entity, ['claude'], gone, r.merged), 'project', root, false);
    expect(await read(path.join(assets, 'hooks/local.sh'))).toBe('mine');
    expect(await exists(path.join(root, kept!))).toBe(true);
    for (const f of gone) expect(await exists(path.join(root, f))).toBe(false);
    expect(await exists(path.join(assets, 'skills'))).toBe(false); // emptied: pruned

    await target.undeploy(mkLock(hook.entity, ['claude'], [kept!]), 'project', root, false);
    expect(await exists(path.join(root, kept!))).toBe(false);
    expect(await read(path.join(assets, 'hooks/local.sh'))).toBe('mine');
  });
});

describe('undeploy keeps unrelated content', () => {
  it('JSON keys, TOML tables with comments, AGENTS.md text and JSONC inputs survive', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const env = fakeEnv(root);
    const AGENTS = '# Team rules\n\nBe kind.\n';
    const TOML =
      '# codex\nmodel = "gpt-6-astra"\n\n[mcp_servers.mine]\ncommand = "mine" # comment\n';
    await write(path.join(root, 'AGENTS.md'), AGENTS);
    await write(path.join(root, '.codex/config.toml'), TOML);
    await write(
      path.join(root, '.claude/settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] },
      }),
    );
    await write(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }),
    );
    await write(
      path.join(root, '.cursor/hooks.json'),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: 'user' }] } }),
    );
    await write(
      path.join(root, '.vscode/mcp.json'),
      '{\n  // secrets\n  "inputs": [{ "id": "k", "type": "promptString" }],\n  "servers": {},\n}\n',
    );
    const GEMINI = '# Gemini house rules\n';
    await write(path.join(root, 'GEMINI.md'), GEMINI);
    const geminiSettings = {
      ui: { theme: 'GitHub' },
      hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'user' }] }] },
      mcpServers: { mine: { command: 'mine' } },
    };
    await write(path.join(root, '.gemini/settings.json'), JSON.stringify(geminiSettings));
    const opencodeJson = {
      $schema: 'https://opencode.ai/config.json',
      instructions: ['CONTRIBUTING.md'],
      mcp: { mine: { type: 'local', command: ['mine'] } },
    };
    await write(path.join(root, 'opencode.json'), JSON.stringify(opencodeJson));
    const JSONC = '{\n  // mine\n  "theme": "opencode",\n}\n';
    await write(path.join(root, 'opencode.jsonc'), JSONC);

    const E = entities(origin);
    const entries: LockEntry[] = [];
    for (const e of Object.values(E)) {
      const files = new Set<string>();
      const merged: MergedRecord[] = [];
      for (const t of allTargets()) {
        const r = await t.deploy(mkInput({ ...e, originRoot: origin.root, scopeRoot: root, env }));
        r.files.forEach((f) => {
          files.add(f);
        });
        merged.push(...(r.merged ?? []));
      }
      entries.push(mkLock(e.entity, [...TARGET_IDS], [...files], merged));
    }
    expect(await read(path.join(root, 'AGENTS.md'))).toContain('palm:begin instruction:demo');
    expect(await read(path.join(root, '.codex/config.toml'))).toContain('[mcp_servers.gh]');

    for (const entry of entries)
      for (const id of TARGET_IDS)
        await createTarget(id).undeploy(entry, 'project', root, false, env);

    expect(await read(path.join(root, 'AGENTS.md'))).toBe(AGENTS);
    expect(await read(path.join(root, '.codex/config.toml'))).toBe(TOML);
    // Lists palm emptied are pruned; everything the user had survives.
    expect(await readJson(path.join(root, '.claude/settings.json'))).toEqual({
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] },
    });
    expect(await readJson(path.join(root, '.mcp.json'))).toEqual({
      mcpServers: { mine: { command: 'mine' } },
    });
    expect(await readJson(path.join(root, '.cursor/hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: 'user' }] },
    });
    expect(await readJson(path.join(root, '.vscode/mcp.json'))).toEqual({
      inputs: [{ id: 'k', type: 'promptString' }],
    });
    expect(await read(path.join(root, 'GEMINI.md'))).toBe(GEMINI);
    expect(await readJson(path.join(root, '.gemini/settings.json'))).toEqual(geminiSettings);
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual(opencodeJson);
    expect(await read(path.join(root, 'opencode.jsonc'))).toBe(JSONC); // never written
    for (const gone of [
      '.claude/agents',
      '.agents/skills',
      '.github',
      '.cursor/rules',
      '.palm/hooks/fmt',
      '.codex/agents',
      '.gemini/agents',
      '.gemini/commands',
      '.opencode/agents',
      '.opencode/instructions',
      '.opencode/commands',
    ]) {
      expect(await exists(path.join(root, gone))).toBe(gone === '.github'); // `.github` is a stop dir: kept (empty)
    }
  });
});

describe('dryRun', () => {
  it('reports files and records without touching disk', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const t = createTarget('cursor', fakeEnv(root));
    const E = entities(origin);
    const a = await t.deploy(mkInput({ ...E.agent, scopeRoot: root, dryRun: true }));
    expect(a.files).toEqual(['.cursor/agents/demo.md']);
    const m = await t.deploy(mkInput({ ...E.mcp, scopeRoot: root, dryRun: true }));
    expect(m.merged).toEqual([
      {
        file: '.cursor/mcp.json',
        pointer: '/mcpServers/gh',
        value: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GH_TOKEN: '${env:GH_TOKEN}' } },
      },
    ]);
    const h = await t.deploy(
      mkInput({ ...E.hook, originRoot: origin.root, scopeRoot: root, dryRun: true }),
    );
    expect(h.merged).toHaveLength(2);
    expect(await fs.readdir(root)).toEqual([]);
    await t.undeploy(
      mkLock(E.agent.entity, ['cursor'], ['.cursor/agents/demo.md']),
      'project',
      root,
      true,
    );
  });
});

describe('environment overrides (global scope)', () => {
  it('honours CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and PALM_HOME', async () => {
    const origin = await makeOrigin();
    const home = await tmpDir();
    const env = fakeEnv(home, {
      CLAUDE_CONFIG_DIR: path.join(home, 'alt-claude'),
      CODEX_HOME: '~/alt-codex',
      COPILOT_HOME: path.join(home, 'alt-copilot'),
      PALM_HOME: path.join(home, 'alt-palm'),
    });
    const E = entities(origin);
    const input = (e: { entity: Entity; absPath: string }) =>
      mkInput({ ...e, originRoot: origin.root, scope: 'global', scopeRoot: home, env });
    expect((await getTarget('claude').deploy(input(E.agent))).files).toEqual([
      path.join(home, 'alt-claude/agents/demo.md'),
    ]);
    expect((await getTarget('claude').deploy(input(E.mcp))).merged![0]!.file).toBe(
      path.join(home, 'alt-claude/.claude.json'),
    );
    expect((await getTarget('codex').deploy(input(E.agent))).files).toEqual([
      path.join(home, 'alt-codex/agents/demo.toml'),
    ]);
    expect((await getTarget('codex').deploy(input(E.instruction))).merged![0]!.file).toBe(
      path.join(home, 'alt-codex/AGENTS.md'),
    );
    expect((await getTarget('copilot').deploy(input(E.agent))).files).toEqual([
      path.join(home, 'alt-copilot/agents/demo.agent.md'),
    ]);
    const hook = await getTarget('cursor').deploy(input(E.hook));
    expect(hook.files).toContain(path.join(home, 'alt-palm/hooks/fmt/hooks/format.sh'));
    expect(JSON.stringify(await readJson(path.join(home, '.cursor/hooks.json')))).toContain(
      path.join(home, 'alt-palm/hooks/fmt/hooks/format.sh'),
    );
    await createTarget('cursor').undeploy(
      mkLock(E.hook.entity, ['cursor'], hook.files, hook.merged),
      'global',
      home,
      false,
      env,
    );
    expect(await exists(path.join(home, 'alt-palm/hooks/fmt'))).toBe(false);
    // skills stay under ~/.agents regardless of CODEX_HOME
    expect((await getTarget('codex').deploy(input(E.skill))).files[0]).toBe(
      path.join(home, '.agents/skills/demo/SKILL.md'),
    );
  });

  it('resolves directory overrides from the call env, then the bound env, then process.env', async () => {
    const origin = await makeOrigin();
    const home = await tmpDir();
    const elsewhere = await tmpDir();
    const bound = await tmpDir();
    vi.stubEnv('CLAUDE_CONFIG_DIR', elsewhere);
    const agent = entities(origin).agent;
    const input = mkInput({ ...agent, scope: 'global', scopeRoot: home, env: fakeEnv(home) });
    // An explicit env wins over process.env: nothing is written to its CLAUDE_CONFIG_DIR.
    expect((await getTarget('claude').deploy(input)).files).toEqual([
      path.join(home, '.claude/agents/demo.md'),
    ]);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    // Without one, the env bound by createTarget() applies, then process.env.
    const t = createTarget('claude', fakeEnv(home, { CLAUDE_CONFIG_DIR: bound }));
    expect((await t.deploy({ ...input, env: undefined })).files).toEqual([
      path.join(bound, 'agents/demo.md'),
    ]);
    expect((await getTarget('claude').deploy({ ...input, env: undefined })).files).toEqual([
      path.join(elsewhere, 'agents/demo.md'),
    ]);
  });
});

describe('detect / configDir / registry', () => {
  it('detects harness markers per scope', async () => {
    const root = await tmpDir();
    const env = fakeEnv(root);
    for (const t of allTargets()) {
      expect(await t.detect('project', root, env)).toBe(false);
      expect(await t.detect('global', root, env)).toBe(false);
    }
    await write(path.join(root, 'CLAUDE.md'), '');
    await write(path.join(root, 'AGENTS.md'), '');
    await write(path.join(root, '.vscode/mcp.json'), '{}');
    await fs.mkdir(path.join(root, '.cursor'));
    await write(path.join(root, 'GEMINI.md'), '');
    await write(path.join(root, 'opencode.json'), '{}');
    for (const t of allTargets()) expect(await t.detect('project', root, env)).toBe(true);
    await fs.mkdir(path.join(root, '.copilot'));
    expect(await getTarget('copilot').detect('global', root, env)).toBe(true);
    expect(await getTarget('cursor').detect('global', root, env)).toBe(true);
    // gemini: `.gemini/` or GEMINI.md (project), ~/.gemini (global); opencode: `.opencode/`,
    // opencode.json or opencode.jsonc (project), ~/.config/opencode (global)
    const other = await tmpDir();
    await fs.mkdir(path.join(other, '.gemini'));
    await write(path.join(other, 'opencode.jsonc'), '{}');
    expect(await getTarget('gemini').detect('project', other, env)).toBe(true);
    expect(await getTarget('opencode').detect('project', other, env)).toBe(true);
    expect(await getTarget('gemini').detect('global', root, env)).toBe(false);
    expect(await getTarget('opencode').detect('global', root, env)).toBe(false);
    await fs.mkdir(path.join(root, '.config/opencode'), { recursive: true });
    expect(await getTarget('opencode').detect('global', root, env)).toBe(true);
    expect(
      await getTarget('gemini').detect('global', root, { ...env, GEMINI_CLI_HOME: other }),
    ).toBe(true);
    expect(
      await getTarget('opencode').detect('global', root, {
        ...env,
        XDG_CONFIG_HOME: path.join(root, 'xdg'),
      }),
    ).toBe(false);
    await fs.mkdir(path.join(root, 'cc'));
    expect(
      await getTarget('claude').detect('global', root, {
        ...env,
        CLAUDE_CONFIG_DIR: path.join(root, 'cc'),
      }),
    ).toBe(true);
    expect(
      await getTarget('codex').detect('global', root, {
        ...env,
        CODEX_HOME: path.join(root, 'cc'),
      }),
    ).toBe(true);
    expect(await getTarget('codex').detect('global', root, env)).toBe(false);
  });

  it('configDir', () => {
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/cc', CODEX_HOME: '/cx' };
    expect(getTarget('claude').configDir('project', '/p', env)).toBe('/p/.claude');
    expect(getTarget('claude').configDir('global', '/h', env)).toBe('/cc');
    expect(getTarget('claude').configDir('global', '/h', { HOME: '/h' })).toBe('/h/.claude');
    expect(getTarget('codex').configDir('project', '/p', env)).toBe('/p/.codex');
    expect(getTarget('codex').configDir('global', '/h', env)).toBe('/cx');
    expect(getTarget('copilot').configDir('project', '/p', env)).toBe('/p/.github');
    expect(getTarget('copilot').configDir('global', '/h', env)).toBe('/h/.copilot');
    expect(getTarget('cursor').configDir('global', '/h', env)).toBe('/h/.cursor');
    expect(getTarget('gemini').configDir('project', '/p', env)).toBe('/p/.gemini');
    expect(getTarget('gemini').configDir('global', '/h', env)).toBe('/h/.gemini');
    expect(getTarget('gemini').configDir('global', '/h', { GEMINI_CLI_HOME: '/g' })).toBe(
      '/g/.gemini',
    );
    expect(getTarget('opencode').configDir('project', '/p', env)).toBe('/p/.opencode');
    expect(getTarget('opencode').configDir('global', '/h', env)).toBe('/h/.config/opencode');
    expect(getTarget('opencode').configDir('global', '/h', { XDG_CONFIG_HOME: '/x' })).toBe(
      '/x/opencode',
    );
    // the overrides only apply to the global scope
    expect(getTarget('opencode').configDir('project', '/p', { XDG_CONFIG_HOME: '/x' })).toBe(
      '/p/.opencode',
    );
  });

  it('getTarget / allTargets', async () => {
    expect(allTargets().map((t) => [t.id, t.displayName])).toEqual([
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
      ['copilot', 'GitHub Copilot'],
      ['cursor', 'Cursor'],
      ['gemini', 'Gemini CLI'],
      ['opencode', 'OpenCode'],
    ]);
    expect(() => getTarget('vim' as TargetId)).toThrowError(/unknown target/);
    const root = await tmpDir();
    const plugin = mkEntity({ kind: 'plugin', members: [] });
    expect(
      await getTarget('claude').deploy(mkInput({ entity: plugin, scopeRoot: root })),
    ).toMatchObject({ files: [], skipped: true });
  });
});

describe('symlinks never copy files from outside the origin (security)', () => {
  afterEach(cleanupTmp);

  it('skill: an outside file/dir link is skipped and reported; a link inside the origin is followed', async () => {
    const origin = await makeOrigin();
    const outside = await tmpDir('palm-outside-');
    await write(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    await write(path.join(outside, 'ssh', 'config'), 'Host *');
    await fs.symlink(path.join(outside, 'id_rsa'), path.join(origin.skillDir, 'leak.md'));
    await fs.symlink(path.join(outside, 'ssh'), path.join(origin.skillDir, 'refs'));
    await write(path.join(origin.root, 'shared', 'glossary.md'), '# glossary');
    await fs.symlink(path.join(origin.root, 'shared'), path.join(origin.skillDir, 'shared'));

    const root = await tmpDir();
    for (const id of ['claude', 'codex'] as const) {
      const r = await getTarget(id).deploy(
        mkInput({
          entity: mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } }),
          absPath: origin.skillDir,
          originRoot: origin.root,
          scopeRoot: root,
        }),
      );
      expect(r.files.some((f) => f.endsWith('/leak.md') || f.includes('/refs/'))).toBe(false);
      expect(r.files.some((f) => f.endsWith('/shared/glossary.md'))).toBe(true);
      expect(r.notes.join('\n')).toMatch(
        /not copied \(symlink leaving the origin, or broken\): leak\.md, refs/,
      );
    }
    for (const dir of ['.claude/skills/demo', '.agents/skills/demo']) {
      expect(await exists(path.join(root, dir, 'leak.md'))).toBe(false);
      expect(await exists(path.join(root, dir, 'refs'))).toBe(false);
    }
  });

  it('a skill directory that is itself a link out of the origin copies nothing', async () => {
    const origin = await makeOrigin();
    const outside = await tmpDir('palm-outside-');
    await write(path.join(outside, 'SKILL.md'), SKILL_MD);
    const linked = path.join(origin.root, 'skills', 'evil');
    await fs.symlink(outside, linked);
    const root = await tmpDir();
    const input = mkInput({
      entity: mkEntity({ kind: 'skill', skill: { name: 'evil', description: 'd' } }, 'evil'),
      absPath: linked,
      originRoot: origin.root,
      scopeRoot: root,
    });
    await expect(getTarget('claude').deploy(input)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(await exists(path.join(root, '.claude/skills/evil'))).toBe(false);
  });

  it('hook assets: a plugin-root link to a home directory is not followed', async () => {
    const origin = await makeOrigin();
    const fakeHome = await tmpDir('palm-home-');
    await write(path.join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    await fs.symlink(fakeHome, path.join(origin.pluginDir, 'home'));
    const root = await tmpDir();
    const hook = mkEntity(
      {
        kind: 'hook',
        hooks: { name: 'fmt', dialect: 'claude', raw: CLAUDE_HOOKS, pluginRootRel: 'plugins/fmt' },
      },
      'fmt',
    );
    const r = await getTarget('claude').deploy(
      mkInput({
        entity: hook,
        absPath: origin.hooksFile,
        originRoot: origin.root,
        scopeRoot: root,
      }),
    );
    expect(r.files.some((f) => f.includes('/home/'))).toBe(false);
    expect(await exists(path.join(root, '.palm/hooks/fmt/home'))).toBe(false);
    expect(r.notes.join('\n')).toMatch(/not copied .*: home/);
  });
});

describe('entity names cannot escape their directory (security)', () => {
  afterEach(cleanupTmp);

  it('deploy refuses traversal names; hook cleanup ignores them', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const victim = path.join(root, 'victim');
    await write(path.join(victim, 'data'), 'keep me');
    const bad = mkEntity(
      { kind: 'skill', skill: { name: '../../victim', description: 'd' } },
      '../../victim',
    );
    await expect(
      getTarget('claude').deploy(
        mkInput({
          entity: bad,
          absPath: origin.skillDir,
          originRoot: origin.root,
          scopeRoot: root,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'E_USAGE',
    });
    const hookEntry = mkLock(
      mkEntity({ kind: 'hook', hooks: { name: 'x', dialect: 'claude', raw: {} } }, '../../victim'),
      ['claude'],
      [],
      [],
    );
    await getTarget('claude').undeploy(hookEntry, 'project', path.join(root, 'project'), false);
    expect(await read(path.join(victim, 'data'))).toBe('keep me');
  });
});

describe('a deploy that fails half-way leaves no untracked files', () => {
  afterEach(cleanupTmp);

  it('rolls back the files it created before the failing write', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    // `scripts/` exists but is read-only: SKILL.md and references/notes.md are written first, then run.sh fails.
    const scripts = path.join(root, '.claude', 'skills', 'demo', 'scripts');
    await fs.mkdir(scripts, { recursive: true });
    await fs.chmod(scripts, 0o500);
    try {
      const input = mkInput({
        entity: mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } }),
        absPath: origin.skillDir,
        originRoot: origin.root,
        scopeRoot: root,
      });
      await expect(getTarget('claude').deploy(input)).rejects.toBeTruthy();
      expect(await exists(path.join(root, '.claude/skills/demo/SKILL.md'))).toBe(false);
      expect(await exists(path.join(root, '.claude/skills/demo/references/notes.md'))).toBe(false);
    } finally {
      await fs.chmod(scripts, 0o755);
    }
  });
});
