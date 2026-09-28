import { describe, expect, it } from 'vitest';
import type { HookSet } from '../../src/core/types.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { convertHooks } from '../../src/targets/convert-hooks.js';
import { CLAUDE_HOOKS } from './helpers.js';

const PROJECT = ScopePaths.at('project', '/proj', { HOME: '/home/u' });
const GLOBAL = ScopePaths.at('global', '/home/u', {});
const ASSET = PROJECT.hooksAssetDir('fmt');
/** What codex and copilot project commands use for the project root. */
const GIT_TOP = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)';
const claudeSet: HookSet = {
  name: 'fmt',
  dialect: 'claude',
  raw: CLAUDE_HOOKS,
  pluginRootRel: 'plugins/fmt',
};

describe('convertHooks from Claude', () => {
  it('claude project: plugin root → $CLAUDE_PROJECT_DIR/.palm/hooks/<n>, entries verbatim', () => {
    const raw = {
      hooks: {
        ...CLAUDE_HOOKS.hooks,
        WorktreeCreate: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
      },
    };
    const r = convertHooks({ ...claudeSet, raw }, 'claude', ASSET, PROJECT);
    expect(r.dropped).toEqual([]);
    expect(r.hooks).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                // the plugin root is also exported, as Claude Code does for plugin hooks
                command:
                  'CLAUDE_PLUGIN_ROOT="$CLAUDE_PROJECT_DIR/.palm/hooks/fmt" "$CLAUDE_PROJECT_DIR/.palm/hooks/fmt/hooks/format.sh"',
                timeout: 30,
              },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        WorktreeCreate: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
      },
    });
  });

  it.each(['claude', 'codex', 'copilot', 'cursor'] as const)(
    '%s project: no absolute path in any command; global keeps the absolute asset dir',
    (target) => {
      const project = JSON.stringify(convertHooks(claudeSet, target, ASSET, PROJECT).hooks);
      expect(project).not.toContain('/proj');
      expect(project).toContain('/.palm/hooks/fmt/hooks/format.sh');
      const global = JSON.stringify(
        convertHooks(claudeSet, target, '/home/u/.palm/hooks/fmt', GLOBAL).hooks,
      );
      expect(global).toContain('/home/u/.palm/hooks/fmt/hooks/format.sh');
    },
  );

  it('claude global: absolute asset dir', () => {
    const r = convertHooks(claudeSet, 'claude', '/home/u/.palm/hooks/fmt', GLOBAL);
    expect(JSON.stringify(r.hooks)).toContain('\\"/home/u/.palm/hooks/fmt/hooks/format.sh\\"');
  });

  it('codex: Claude schema, unsupported events dropped, extra fields kept', () => {
    const raw = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/s.sh', statusMessage: 'Loading' },
            ],
          },
        ],
        Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
      },
    };
    const r = convertHooks({ ...claudeSet, raw }, 'codex', ASSET, PROJECT);
    expect(r.hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: `CLAUDE_PLUGIN_ROOT="${GIT_TOP}/.palm/hooks/fmt" ${GIT_TOP}/.palm/hooks/fmt/s.sh`,
                statusMessage: 'Loading',
              },
            ],
          },
        ],
      },
    });
    expect(r.dropped).toEqual(['Notification: not supported by codex']);
  });

  it('cursor: camelCase events, flat entries, version 1', () => {
    const raw = {
      hooks: {
        ...CLAUDE_HOOKS.hooks,
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: 'guard' },
              { type: 'prompt', prompt: 'p' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'done' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'n' }] }],
        TeammateIdle: [{ hooks: [{ type: 'command', command: 't' }] }],
      },
    };
    const r = convertHooks({ ...claudeSet, raw }, 'cursor', ASSET, PROJECT);
    expect(r.hooks).toEqual({
      version: 1,
      hooks: {
        postToolUse: [
          {
            command:
              'CURSOR_PLUGIN_ROOT="$CURSOR_PROJECT_DIR/.palm/hooks/fmt" "$CURSOR_PROJECT_DIR/.palm/hooks/fmt/hooks/format.sh"',
            matcher: 'Edit|Write',
            timeout: 30,
          },
        ],
        sessionStart: [{ command: 'echo hi' }],
        beforeSubmitPrompt: [{ command: 'guard' }],
        stop: [{ command: 'done' }],
      },
    });
    expect(r.dropped).toEqual([
      'UserPromptSubmit: prompt hook not convertible',
      'TeammateIdle: no equivalent event',
      'Notification: not supported by cursor',
    ]);
  });

  it('copilot: bash/timeoutSec, agentStop, userPromptSubmitted', () => {
    const raw = {
      hooks: {
        ...CLAUDE_HOOKS.hooks,
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'guard' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'done', timeout: 5 }] }],
      },
    };
    const r = convertHooks({ ...claudeSet, raw }, 'copilot', ASSET, PROJECT);
    expect(r.hooks).toEqual({
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: 'command',
            bash: `"${GIT_TOP}/.palm/hooks/fmt/hooks/format.sh"`,
            timeoutSec: 30,
            matcher: 'Edit|Write',
          },
        ],
        sessionStart: [{ type: 'command', bash: 'echo hi' }],
        userPromptSubmitted: [{ type: 'command', bash: 'guard' }],
        agentStop: [{ type: 'command', bash: 'done', timeoutSec: 5 }],
      },
    });
    expect(r.dropped).toEqual([]);
  });
});

describe('convertHooks into Claude', () => {
  it('cursor → claude: groups by matcher, ${CURSOR_PLUGIN_ROOT} substituted, unknown events dropped', () => {
    const set: HookSet = {
      name: 'c',
      dialect: 'cursor',
      raw: {
        version: 1,
        hooks: {
          preToolUse: [
            { command: '${CURSOR_PLUGIN_ROOT}/a.sh', matcher: 'Shell', timeout: 10 },
            { command: 'b.sh', matcher: 'Shell' },
            { command: 'c.sh' },
          ],
          beforeSubmitPrompt: [{ command: 'p.sh' }],
          beforeShellExecution: [{ command: 'x.sh' }],
        },
      },
    };
    const r = convertHooks(set, 'claude', '/abs/c', GLOBAL);
    expect(r.hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Shell',
            hooks: [
              { type: 'command', command: 'CLAUDE_PLUGIN_ROOT="/abs/c" /abs/c/a.sh', timeout: 10 },
              { type: 'command', command: 'b.sh' },
            ],
          },
          { hooks: [{ type: 'command', command: 'c.sh' }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'p.sh' }] }],
      },
    });
    expect(r.dropped).toEqual(['beforeShellExecution: no equivalent event']);
  });

  it('copilot → claude: bash → command, timeoutSec → timeout, agentStop → Stop', () => {
    const set: HookSet = {
      name: 'g',
      dialect: 'copilot',
      raw: {
        version: 1,
        hooks: {
          agentStop: [
            { type: 'command', bash: './stop.sh', powershell: './stop.ps1', timeoutSec: 15 },
          ],
          userPromptSubmitted: [{ type: 'command', command: 'log', cwd: 'scripts' }],
          errorOccurred: [{ type: 'command', bash: 'e' }],
        },
      },
    };
    const r = convertHooks(set, 'claude', '/abs/g', PROJECT);
    expect(r.hooks).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: './stop.sh', timeout: 15 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'log' }] }],
      },
    });
    expect(r.dropped).toEqual([
      'userPromptSubmitted: cwd/env of "log"',
      'errorOccurred: no equivalent event',
    ]);
  });

  it('cursor → copilot and copilot → cursor go through the canonical form', () => {
    const cur: HookSet = {
      name: 'c',
      dialect: 'cursor',
      raw: { version: 1, hooks: { stop: [{ command: 's' }] } },
    };
    expect(convertHooks(cur, 'copilot', '/a', PROJECT).hooks).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: 's' }] },
    });
    const cop: HookSet = {
      name: 'c',
      dialect: 'copilot',
      raw: { version: 1, hooks: { sessionStart: [{ bash: 's', timeoutSec: 3 }] } },
    };
    expect(convertHooks(cop, 'cursor', '/a', PROJECT).hooks).toEqual({
      version: 1,
      hooks: { sessionStart: [{ command: 's', timeout: 3 }] },
    });
  });

  it('same-family native events are kept (cursor → cursor)', () => {
    const cur: HookSet = {
      name: 'c',
      dialect: 'cursor',
      raw: {
        version: 1,
        hooks: { afterFileEdit: [{ command: '${CURSOR_PLUGIN_ROOT}/f.sh', loop_limit: 2 }] },
      },
    };
    expect(convertHooks(cur, 'cursor', '/a', PROJECT)).toEqual({
      hooks: {
        version: 1,
        hooks: { afterFileEdit: [{ command: 'CURSOR_PLUGIN_ROOT="/a" /a/f.sh', loop_limit: 2 }] },
      },
      dropped: [],
    });
  });

  it('PowerShell commands get the substitution but no POSIX env prefix; commands without the root are untouched', () => {
    const raw = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: '& "${CLAUDE_PLUGIN_ROOT}/s.ps1"', shell: 'powershell' },
              { type: 'command', command: 'echo hi' },
            ],
          },
        ],
      },
    };
    expect(convertHooks({ ...claudeSet, raw }, 'claude', '/a', GLOBAL).hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: '& "/a/s.ps1"', shell: 'powershell' },
              { type: 'command', command: 'echo hi' },
            ],
          },
        ],
      },
    });
  });

  it('gemini: event names mapped and ms timeouts converted', () => {
    const gem: HookSet = {
      name: 'g',
      dialect: 'gemini',
      raw: {
        hooks: {
          BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'c', timeout: 1500 }] }],
        },
      },
    };
    expect(convertHooks(gem, 'claude', '/a', PROJECT).hooks).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'c', timeout: 2 }] }],
      },
    });
  });
});
