/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on hooks and MCP servers, targets
 * side: one test per ruling id.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entity, HookSet, TargetId } from '../../src/core/types.js';
import { convertHooks, type Relocate } from '../../src/targets/convert-hooks.js';
import { projectRelativeCommand } from '../../src/targets/hook-equivalence.js';
import { createTarget } from '../../src/targets/index.js';
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
