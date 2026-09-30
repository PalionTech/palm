import { describe, expect, it } from 'vitest';
import type { HookSet, Scope, SourceReference, TargetId } from '../../src/core/types.js';
import { convertHooks, type Relocate } from '../../src/targets/convert-hooks.js';
import { relocateCommand } from '../../src/targets/relocate.js';
import { CLAUDE_HOOKS, FMT_HOOKS } from './helpers.js';

/** What codex and copilot project commands use for the project root. */
const GIT_TOP = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)';
const ENV = { HOME: '/home/u' };

/** relocateCommand bound to a target, the hook's references and its asset root. */
function relocator(
  target: TargetId,
  refs: SourceReference[],
  scope: Scope = 'project',
  name = 'fmt',
): Relocate {
  const assetsRoot = `${scope === 'project' ? '.palm' : '<palm>'}/assets/acme__kit/${name}`;
  return (command, opts) =>
    relocateCommand(command, refs, target, { assetsRoot, scope, env: ENV, ...opts });
}

/** A relocation that changes nothing: for tests about dialects and matchers. */
const asIs: Relocate = (command) => ({ canonical: command, rendered: command });

function hookSet(dialect: HookSet['dialect'], raw: unknown, refs: SourceReference[] = []): HookSet {
  return { name: 'h', dialect, raw, references: refs, closure: { paths: [] }, promptHooks: [] };
}

function convert(set: HookSet, target: TargetId, scope: Scope = 'project') {
  return convertHooks(set, target, relocator(target, set.references, scope, set.name));
}

describe('convertHooks from Claude', () => {
  it('claude project: plugin root relocated under $CLAUDE_PROJECT_DIR, entries verbatim', () => {
    const raw = {
      hooks: {
        ...CLAUDE_HOOKS.hooks,
        WorktreeCreate: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
      },
    };
    const r = convert({ ...FMT_HOOKS, raw }, 'claude');
    expect(r.dropped).toEqual([]);
    const root = '"$CLAUDE_PROJECT_DIR"/.palm/assets/acme__kit/fmt/plugins/fmt';
    const script = '"$CLAUDE_PROJECT_DIR/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh"';
    expect(r.hooks).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                // the plugin root is also exported, as Claude Code does for plugin hooks
                command: `CLAUDE_PLUGIN_ROOT=${root} ${script}`,
                timeout: 30,
              },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        WorktreeCreate: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
      },
    });
    expect(r.exec).toEqual([
      {
        id: 'PostToolUse//Edit|Write',
        canonical: '"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh"',
        command: `CLAUDE_PLUGIN_ROOT=${root} ${script}`,
        file: '',
        event: 'PostToolUse',
        matcher: 'Edit|Write',
      },
      {
        id: 'SessionStart//-',
        canonical: 'echo hi',
        command: 'echo hi',
        file: '',
        event: 'SessionStart',
      },
    ]);
  });

  it.each(['claude', 'codex', 'copilot', 'cursor', 'gemini'] as const)(
    '%s: no absolute path in any command at either scope; the canonical form is the same',
    (target) => {
      const project = convert(FMT_HOOKS, target);
      const global = convert(FMT_HOOKS, target, 'global');
      expect(JSON.stringify(project.hooks)).toContain(
        '/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh',
      );
      expect(JSON.stringify(global.hooks)).toContain(
        '$HOME/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh',
      );
      expect(JSON.stringify([project, global])).not.toContain('/home/u');
      expect(project.exec.map((e) => [e.id, e.canonical])).toEqual(
        global.exec.map((e) => [e.id, e.canonical]),
      );
    },
  );

  it('codex: Claude schema, unsupported events dropped, extra fields kept', () => {
    const ref: SourceReference = {
      raw: '${CLAUDE_PLUGIN_ROOT}/s.sh',
      form: 'plugin-root',
      site: 'command',
      rel: 's.sh',
    };
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
    const r = convert(hookSet('claude', raw, [ref]), 'codex');
    const root = `"${GIT_TOP}"/.palm/assets/acme__kit/h`;
    expect(r.hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: `CLAUDE_PLUGIN_ROOT=${root} ${root}/s.sh`,
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
    const r = convert({ ...FMT_HOOKS, raw }, 'cursor');
    const root = '"$CURSOR_PROJECT_DIR"/.palm/assets/acme__kit/fmt/plugins/fmt';
    expect(r.hooks).toEqual({
      version: 1,
      hooks: {
        postToolUse: [
          {
            command: `CURSOR_PLUGIN_ROOT=${root} CLAUDE_PLUGIN_ROOT=${root} "$CURSOR_PROJECT_DIR/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh"`,
            // Cursor's tool type for every file write (R8 M8)
            matcher: 'Write',
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
    // exec ids use Claude's event and tool names on every target
    expect(r.exec.map((e) => e.id)).toEqual([
      'PostToolUse//Edit|Write',
      'SessionStart//-',
      'UserPromptSubmit//-',
      'Stop//-',
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
    const r = convertHooks({ ...FMT_HOOKS, raw }, 'copilot', asIs);
    expect(r.hooks).toEqual({
      version: 1,
      hooks: {
        postToolUse: [
          {
            type: 'command',
            bash: '"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh"',
            timeoutSec: 30,
            // Copilot tool names (R8 M8)
            matcher: 'edit|create',
          },
        ],
        sessionStart: [{ type: 'command', bash: 'echo hi' }],
        userPromptSubmitted: [{ type: 'command', bash: 'guard' }],
        agentStop: [{ type: 'command', bash: 'done', timeoutSec: 5 }],
      },
    });
    expect(r.dropped).toEqual([]);
  });

  it('a repeated (event, matcher) gets a numbered id', () => {
    const raw = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'a' },
              { type: 'command', command: 'b' },
            ],
          },
        ],
      },
    };
    const ids = (t: TargetId) =>
      convertHooks(hookSet('claude', raw), t, asIs).exec.map((e) => e.id);
    expect(ids('claude')).toEqual(['Stop//-', 'Stop//-#2']);
    expect(ids('cursor')).toEqual(['Stop//-', 'Stop//-#2']);
  });
});

describe('convertHooks into Claude', () => {
  it('cursor → claude: groups by matcher, ${CURSOR_PLUGIN_ROOT} relocated, unknown events dropped', () => {
    const ref: SourceReference = {
      raw: '${CURSOR_PLUGIN_ROOT}/a.sh',
      form: 'plugin-root',
      site: 'command',
      rel: 'a.sh',
    };
    const set = hookSet(
      'cursor',
      {
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
      [ref],
    );
    const r = convert(set, 'claude', 'global');
    const root = '"$HOME"/.palm/assets/acme__kit/h';
    expect(r.hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            // Cursor's `Shell` is Claude's `Bash` (R8 M8)
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `CLAUDE_PLUGIN_ROOT=${root} ${root}/a.sh`, timeout: 10 },
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
    const set = hookSet('copilot', {
      version: 1,
      hooks: {
        agentStop: [{ type: 'command', bash: 'stop', powershell: './stop.ps1', timeoutSec: 15 }],
        userPromptSubmitted: [{ type: 'command', command: 'log', cwd: 'scripts' }],
        errorOccurred: [{ type: 'command', bash: 'e' }],
      },
    });
    const r = convertHooks(set, 'claude', asIs);
    expect(r.hooks).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'stop', timeout: 15 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'log' }] }],
      },
    });
    expect(r.dropped).toEqual([
      'userPromptSubmitted: cwd/env of "log"',
      'errorOccurred: no equivalent event',
    ]);
  });

  it('cursor → copilot and copilot → cursor go through the canonical form', () => {
    const cur = hookSet('cursor', { version: 1, hooks: { stop: [{ command: 's' }] } });
    expect(convertHooks(cur, 'copilot', asIs).hooks).toEqual({
      version: 1,
      hooks: { agentStop: [{ type: 'command', bash: 's' }] },
    });
    const cop = hookSet('copilot', {
      version: 1,
      hooks: { sessionStart: [{ bash: 's', timeoutSec: 3 }] },
    });
    expect(convertHooks(cop, 'cursor', asIs).hooks).toEqual({
      version: 1,
      hooks: { sessionStart: [{ command: 's', timeout: 3 }] },
    });
  });

  it('same-family native events are kept (cursor → cursor)', () => {
    const cur = hookSet('cursor', {
      version: 1,
      hooks: { afterFileEdit: [{ command: 'f.sh', loop_limit: 2 }] },
    });
    expect(convertHooks(cur, 'cursor', asIs).hooks).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: 'f.sh', loop_limit: 2 }] },
    });
  });

  it('PowerShell commands get the path but no POSIX env prefix; commands without references are untouched', () => {
    const ref: SourceReference = {
      raw: '${CLAUDE_PLUGIN_ROOT}/s.ps1',
      form: 'plugin-root',
      site: 'command',
      rel: 's.ps1',
    };
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
    expect(convert(hookSet('claude', raw, [ref]), 'claude', 'global').hooks).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '& "$HOME/.palm/assets/acme__kit/h/s.ps1"',
                shell: 'powershell',
              },
              { type: 'command', command: 'echo hi' },
            ],
          },
        ],
      },
    });
  });

  it('gemini: event names mapped and ms timeouts converted', () => {
    const gem = hookSet('gemini', {
      hooks: {
        BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'c', timeout: 1500 }] }],
      },
    });
    expect(convertHooks(gem, 'claude', asIs).hooks).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'c', timeout: 2 }] }],
      },
    });
  });
});

describe('hook matchers translated both ways (R8 M8)', () => {
  const matchersOf = (hooks: unknown): string[] =>
    JSON.stringify(hooks)
      .match(/"matcher":"[^"]*"/g)
      ?.map((m) => m.slice('"matcher":"'.length, -1)) ?? [];
  const matchers = (set: HookSet, t: TargetId) => matchersOf(convertHooks(set, t, asIs).hooks);

  it('gemini → claude/codex/cursor/copilot: Gemini tool names become the target names', () => {
    const set = hookSet('gemini', {
      hooks: {
        BeforeTool: [
          { matcher: 'run_shell_command|write_file', hooks: [{ type: 'command', command: 'a' }] },
        ],
        AfterTool: [{ matcher: 'mcp_github_.*', hooks: [{ type: 'command', command: 'b' }] }],
      },
    });
    expect(matchers(set, 'claude')).toEqual(['Bash|Write', 'mcp__github__.*']);
    expect(matchers(set, 'codex')).toEqual(['Bash|Write', 'mcp__github__.*']);
    expect(matchers(set, 'cursor')).toEqual(['Shell|Write', 'MCP:.*']);
    expect(matchers(set, 'copilot')).toEqual(['bash|create', 'mcp__github__.*']);
    // the exec id is in Claude's names whatever the target
    expect(convertHooks(set, 'gemini', asIs).exec.map((e) => e.id)).toEqual([
      'PreToolUse//Bash|Write',
      'PostToolUse//mcp__github__.*',
    ]);
  });

  it('cursor → gemini and copilot → claude go through Claude names', () => {
    const cursor = hookSet('cursor', {
      version: 1,
      hooks: { preToolUse: [{ command: 'x', matcher: 'Shell|Read' }] },
    });
    expect(matchers(cursor, 'gemini')).toEqual(['run_shell_command|read_file']);
    const copilot = hookSet('copilot', {
      version: 1,
      hooks: { postToolUse: [{ type: 'command', bash: 'y', matcher: 'bash|edit|view' }] },
    });
    expect(matchers(copilot, 'claude')).toEqual(['Bash|Edit|Read']);
  });

  it('non-tool events keep their matcher; regex matchers are mapped in place', () => {
    const set = hookSet('gemini', {
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 's' }] }],
        BeforeTool: [{ matcher: '(replace|glob)', hooks: [{ type: 'command', command: 't' }] }],
      },
    });
    expect(matchers(set, 'claude')).toEqual(['startup', '(Edit|Glob)']);
  });
});

describe('references the relocation cannot resolve', () => {
  it('an unresolved reference and a plugin-root token no reference covers are refused', () => {
    const unresolved: SourceReference = {
      raw: './missing.sh',
      form: 'relative',
      site: 'command',
      unresolved: 'no such file under hooks/',
    };
    const raw = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash ./missing.sh' }] }] },
    };
    expect(() => convert(hookSet('claude', raw, [unresolved]), 'claude')).toThrow(
      /cannot relocate "\.\/missing\.sh".*no such file/,
    );
    const bare = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/x' }] }] },
    };
    expect(() => convert(hookSet('claude', bare), 'claude')).toThrow(/cannot relocate/);
  });
});
