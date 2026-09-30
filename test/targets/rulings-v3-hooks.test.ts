/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on hooks and MCP servers, targets
 * side: one test per ruling id.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entity, HookSet, TargetId } from '../../src/core/types.js';
import { convertHooks, type Relocate } from '../../src/targets/convert-hooks.js';
import { fragmentText } from '../../src/targets/fragment-text.js';
import { projectRelativeCommand } from '../../src/targets/hook-equivalence.js';
import { createTarget } from '../../src/targets/index.js';
import { renderMcp } from '../../src/targets/mcp-config.js';
import { cleanupTmp, fakeEnv, install, mkEntity, readJson, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const asIs: Relocate = (command) => ({ canonical: command, rendered: command });

function hookSet(dialect: HookSet['dialect'], raw: unknown): HookSet {
  return { name: 'quality', dialect, raw, references: [], closure: { paths: [] }, promptHooks: [] };
}

const stopHook = (command: string) => ({
  hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 600 }] }] },
});

function hookEntity(raw: unknown): Entity {
  const hooks = hookSet('claude', raw);
  return mkEntity({ kind: 'hook', hooks }, 'quality', 'hooks/quality/hooks.json');
}

async function installHook(id: TargetId, root: string, raw: unknown) {
  const src = await tmpDir('palm-source-');
  const entity = hookEntity(raw);
  const absPath = path.join(src, entity.path);
  await write(absPath, JSON.stringify(raw));
  const target = createTarget(id, fakeEnv(root));
  const c = { entity, absPath, scope: 'project' as const, scopeRoot: root, sourceRoot: src };
  return install(target, c, { inPlace: true, assetsRoot: 'hooks/quality' });
}

type Settings = { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };

describe('O11 an equivalent hook already on disk is adopted, Copilot keeps powershell and cwd', () => {
  it('O11 a hand-written Stop hook naming the program through $CLAUDE_PROJECT_DIR is adopted', async () => {
    const root = await tmpDir();
    const settings = path.join(root, '.claude/settings.json');
    const mine = 'go run "$CLAUDE_PROJECT_DIR/.agents/hooks/main.go"';
    await write(settings, JSON.stringify(stopHook(mine)));
    const { result } = await installHook('claude', root, stopHook('go run .agents/hooks/main.go'));
    const doc = (await readJson(settings)) as Settings;
    expect(doc.hooks.Stop).toHaveLength(1);
    expect(doc.hooks.Stop[0]?.hooks[0]?.command).toBe('go run .agents/hooks/main.go');
    expect(result.notes).toContain(
      '.claude/settings.json: adopted the Stop hook already there (the same command); no second copy',
    );
  });

  it('O11 a hook with other arguments is no equivalent: palm adds its own beside it', async () => {
    const root = await tmpDir();
    const settings = path.join(root, '.claude/settings.json');
    const mine = 'go run "$CLAUDE_PROJECT_DIR/.agents/hooks/main.go" --harness claude';
    await write(settings, JSON.stringify(stopHook(mine)));
    const { result } = await installHook('claude', root, stopHook('go run .agents/hooks/main.go'));
    const doc = (await readJson(settings)) as Settings;
    expect(doc.hooks.Stop.map((g) => g.hooks[0]?.command)).toEqual([
      mine,
      'go run .agents/hooks/main.go',
    ]);
    expect(result.notes.join('\n')).not.toContain('adopted');
  });

  it('O11 the project-dir idiom of every harness is set aside', () => {
    const want = 'node tools/x.js --fast';
    for (const written of [
      'node "$CLAUDE_PROJECT_DIR/tools/x.js" --fast',
      'node "$CLAUDE_PROJECT_DIR"/tools/x.js --fast',
      'node ${CURSOR_PROJECT_DIR}/tools/x.js  --fast',
      'node "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"/tools/x.js --fast',
      'node ./tools/x.js --fast',
      'node "tools/x.js" --fast',
    ])
      expect(projectRelativeCommand(written)).toBe(want);
  });

  it('O11 Copilot gets a powershell line for a program both shells run, never for a shell script', () => {
    const raw = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'go run .agents/hooks/main.go', timeout: 600 }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: './hooks/start.sh' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'jq -r .x | tee "$LOG"' }] }],
      },
    };
    expect(convertHooks(hookSet('claude', raw), 'copilot', asIs).hooks).toEqual({
      version: 1,
      hooks: {
        agentStop: [
          {
            type: 'command',
            bash: 'go run .agents/hooks/main.go',
            powershell: 'go run .agents/hooks/main.go',
            timeoutSec: 600,
          },
        ],
        sessionStart: [{ type: 'command', bash: './hooks/start.sh' }],
        preToolUse: [{ type: 'command', bash: 'jq -r .x | tee "$LOG"' }],
      },
    });
  });

  it('O11 a Claude PowerShell hook is Copilot’s powershell line, and dropped where hooks run with sh', () => {
    const raw = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '& ./stop.ps1', shell: 'powershell' }] }],
      },
    };
    const set = hookSet('claude', raw);
    expect(convertHooks(set, 'copilot', asIs).hooks).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', powershell: '& ./stop.ps1' }] },
    });
    const cursor = convertHooks(set, 'cursor', asIs);
    expect(cursor.hooks).toEqual({ version: 1, hooks: {} });
    expect(cursor.dropped).toEqual(['Stop: PowerShell hook (cursor runs hooks with sh)']);
  });

  it('O11 a Copilot source keeps powershell, cwd and env for Copilot', () => {
    const entry = {
      type: 'command',
      bash: 'go run main.go --harness copilot',
      powershell: 'go run main.go --harness copilot',
      cwd: '.',
      env: { MODE: 'ci' },
      timeoutSec: 600,
    };
    const set = hookSet('copilot', { version: 1, hooks: { agentStop: [entry] } });
    expect(convertHooks(set, 'copilot', asIs).hooks).toEqual({
      version: 1,
      hooks: { agentStop: [entry] },
    });
  });
});

describe('Q8 an optional header reference renders in each harness’s optional form', () => {
  const cfg = {
    name: 'context7',
    transport: 'http' as const,
    url: 'https://mcp.context7.com/mcp',
    headers: { Authorization: 'Bearer ${CONTEXT7_TOKEN:-}' },
  };
  const headersOf = (id: TargetId) =>
    (renderMcp(cfg, id, 'env-ref').entry as { headers?: Record<string, string> }).headers;

  it('Q8 Claude and Gemini keep ${VAR:-}; Cursor and VS Code read an unset ${env:VAR} as empty', () => {
    expect(headersOf('claude')).toEqual({ Authorization: 'Bearer ${CONTEXT7_TOKEN:-}' });
    expect(headersOf('gemini')).toEqual({ Authorization: 'Bearer ${CONTEXT7_TOKEN:-}' });
    expect(headersOf('cursor')).toEqual({ Authorization: 'Bearer ${env:CONTEXT7_TOKEN}' });
    expect(renderMcp(cfg, 'claude', 'env-ref').optionalRefs).toEqual(['CONTEXT7_TOKEN']);
  });

  it('Q8 the install note calls the variable optional; Codex says it has no optional form', async () => {
    const root = await tmpDir();
    const entity = mkEntity(
      { kind: 'mcp', mcp: cfg, references: [], closure: { paths: [] } },
      'context7',
      '.mcp.json',
    );
    const src = path.join(root, 'src');
    const c = { entity, absPath: path.join(src, '.mcp.json'), scope: 'project' as const };
    const { rendered } = await install(createTarget('claude', fakeEnv(root)), {
      ...c,
      scopeRoot: root,
      sourceRoot: src,
    });
    expect(rendered.notes).toContain('optional in the environment: CONTEXT7_TOKEN');
    expect(rendered.notes.join('\n')).not.toContain('needs CONTEXT7_TOKEN');
    const codex = renderMcp(cfg, 'codex', 'env-ref');
    expect(codex.entry).toMatchObject({ bearer_token_env_var: 'CONTEXT7_TOKEN' });
    expect(codex.notes).toContain(
      'Codex has no optional form for CONTEXT7_TOKEN: export it before starting Codex',
    );
  });
});

describe('R20′ describe shows each fragment in its file’s own language', () => {
  const server = {
    name: 'docs',
    transport: 'http' as const,
    url: 'https://docs.test/mcp',
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
  };

  async function fragmentOf(id: TargetId) {
    const root = await tmpDir();
    const entity = mkEntity(
      { kind: 'mcp', mcp: server, references: [], closure: { paths: [] } },
      'docs',
      '.mcp.json',
    );
    const src = path.join(root, 'src');
    const r = await createTarget(id, fakeEnv(root)).render({
      entity,
      absPath: path.join(src, '.mcp.json'),
      sourceRoot: src,
      source: { name: 'acme/kit', type: 'git', url: 'https://github.com/acme/kit.git' },
      scope: 'project',
      scopeRoot: root,
      assetsRoot: '.palm/assets/acme__kit/docs',
      inPlace: false,
      secretPolicy: 'env-ref',
    });
    return r.fragments[0] as NonNullable<(typeof r.fragments)[0]>;
  }

  it('R20′ the Codex server is its [mcp_servers.<name>] TOML table', async () => {
    expect(fragmentText(await fragmentOf('codex'))).toBe(
      [
        '[mcp_servers.docs]',
        'url = "https://docs.test/mcp"',
        'bearer_token_env_var = "DOCS_TOKEN"',
      ].join('\n'),
    );
  });

  it('R20′ a JSON harness shows JSON, a markdown block its text', async () => {
    expect(JSON.parse(fragmentText(await fragmentOf('claude')))).toEqual({
      type: 'http',
      url: 'https://docs.test/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    const block = { file: 'AGENTS.md', at: 'block:palm:instruction:x', value: 'Be strict.\n' };
    expect(fragmentText(block)).toBe('Be strict.');
  });
});

describe('M8 S15 a hook’s asset closure holds only the definition files an active target reads', () => {
  const claudeHooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
  const cursorHooks = { version: 1, hooks: { sessionStart: [{ command: 'x' }] } };

  /** A superpowers-shaped plugin: hooks/ holds both dialects, the runner and a refused hook. */
  async function pluginSource(): Promise<string> {
    const src = await tmpDir('palm-source-');
    await write(path.join(src, 'hooks/hooks.json'), JSON.stringify(claudeHooks));
    await write(path.join(src, 'hooks/hooks-cursor.json'), JSON.stringify(cursorHooks));
    await write(path.join(src, 'hooks/run-hook.cmd'), '#!/bin/sh\nexec "$@"\n', 0o755);
    await write(path.join(src, 'hooks/session-start'), '#!/bin/sh\ncat skill.md\n', 0o755);
    await write(path.join(src, 'hooks/ghost/hooks.json'), JSON.stringify(claudeHooks));
    await write(path.join(src, 'hooks/ghost/notes.json'), '{"a":[1]}');
    return src;
  }

  async function assetsFor(active: TargetId[], reads?: string[]): Promise<string[]> {
    const src = await pluginSource();
    const root = await tmpDir();
    const hooks: HookSet = {
      ...hookSet('claude', claudeHooks),
      closure: { paths: ['hooks'], ...(reads ? { reads } : {}) },
    };
    const entity = mkEntity({ kind: 'hook', hooks }, 'superpowers', 'hooks/hooks.json');
    const r = await createTarget('claude', fakeEnv(root)).render({
      entity,
      absPath: path.join(src, 'hooks/hooks.json'),
      sourceRoot: src,
      source: { name: 'obra/superpowers', type: 'git', url: 'https://github.com/o/s.git' },
      scope: 'project',
      scopeRoot: root,
      assetsRoot: '.palm/assets/obra__superpowers/superpowers',
      inPlace: false,
      secretPolicy: 'env-ref',
      targets: active,
    });
    const prefix = '.palm/assets/obra__superpowers/superpowers/';
    return r.files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path.slice(prefix.length));
  }

  it('M8 hooks-cursor.json is left out when cursor is not a target, kept when it is', async () => {
    expect(await assetsFor(['claude', 'codex', 'copilot'])).toEqual([
      'hooks/ghost/notes.json',
      'hooks/hooks.json',
      'hooks/run-hook.cmd',
      'hooks/session-start',
    ]);
    expect(await assetsFor(['claude', 'cursor'])).toContain('hooks/hooks-cursor.json');
    expect(await assetsFor(['copilot'])).not.toContain('hooks/hooks.json');
  });

  it('S15 another hook’s definition in a subfolder is never vendored; a file a script reads is', async () => {
    expect(await assetsFor(['claude'])).not.toContain('hooks/ghost/hooks.json');
    expect(await assetsFor(['claude'], ['hooks/ghost/hooks.json'])).toContain(
      'hooks/ghost/hooks.json',
    );
  });
});
