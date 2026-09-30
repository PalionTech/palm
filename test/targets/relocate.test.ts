/**
 * Relocation (DESIGN.md section 2): each harness's project-dir idiom, global scope ("$HOME",
 * never an absolute path), in-place local sources, quoting contexts, the canonical form, the
 * exported plugin-root variable, and MCP fields.
 */
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, SourceReference, TargetId } from '../../src/core/types.js';
import { PROJECT_DIR } from '../../src/targets/index.js';
import { relocateCommand, relocateMcp } from '../../src/targets/relocate.js';

vi.mock('../../src/domain/ignore.js', async (orig) =>
  (await import('./fakes.js')).withIgnore(await orig()),
);

const HOME = '/home/u';
const ASSETS = '.palm/assets/acme__kit/fmt';
const ROOT_REF: SourceReference = {
  raw: '${CLAUDE_PLUGIN_ROOT}/hooks/run.sh',
  form: 'plugin-root',
  site: 'command',
  rel: 'plugins/fmt/hooks/run.sh',
};
const REL_REF: SourceReference = {
  raw: './scripts/check.sh',
  form: 'relative',
  site: 'command',
  rel: 'plugins/fmt/hooks/scripts/check.sh',
};

function project(command: string, target: TargetId, refs: SourceReference[] = [ROOT_REF]) {
  return relocateCommand(command, refs, target, {
    assetsRoot: ASSETS,
    scope: 'project',
    env: { HOME },
  });
}

function global(command: string, env: NodeJS.ProcessEnv = { HOME }, refs = [ROOT_REF]) {
  return relocateCommand(command, refs, 'claude', {
    assetsRoot: '<palm>/assets/acme__kit/fmt',
    scope: 'global',
    env,
  });
}

describe('project-dir idioms', () => {
  it('PROJECT_DIR holds the quoted idiom of each harness', () => {
    expect(PROJECT_DIR).toEqual({
      claude: '"$CLAUDE_PROJECT_DIR"',
      codex: '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
      copilot: '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
      cursor: '"$CURSOR_PROJECT_DIR"',
      gemini: '"$GEMINI_PROJECT_DIR"',
      opencode: '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    });
  });

  it.each(['claude', 'codex', 'copilot', 'cursor', 'gemini'] as const)(
    '%s: an unquoted reference becomes <idiom>/<assets>/<rel>, the plugin root exported',
    (target) => {
      const r = project('bash ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh --fix', target);
      const idiom = PROJECT_DIR[target];
      const root = `${idiom}/${ASSETS}/plugins/fmt`;
      const exports =
        target === 'cursor'
          ? `CURSOR_PLUGIN_ROOT=${root} CLAUDE_PLUGIN_ROOT=${root} `
          : `CLAUDE_PLUGIN_ROOT=${root} `;
      expect(r.rendered).toBe(`${exports}bash ${root}/hooks/run.sh --fix`);
      expect(r.canonical).toBe('bash ${CLAUDE_PLUGIN_ROOT}/hooks/run.sh --fix');
    },
  );

  it('project-dir tokens are translated to the target idiom; the own variable stays', () => {
    const cmd = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh && echo $CLAUDE_PROJECT_DIR';
    expect(project(cmd, 'claude', []).rendered).toBe(cmd);
    expect(project(cmd, 'cursor', []).rendered).toBe(
      '"$CURSOR_PROJECT_DIR"/.claude/hooks/x.sh && echo "$CURSOR_PROJECT_DIR"',
    );
    expect(project(cmd, 'codex', []).rendered).toBe(
      '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"/.claude/hooks/x.sh && echo "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    );
    expect(project('${CURSOR_PROJECT_DIR}/x', 'gemini', []).rendered).toBe(
      '"$GEMINI_PROJECT_DIR"/x',
    );
    expect(project(cmd, 'codex', []).canonical).toBe(cmd);
  });
});

describe('quoting', () => {
  it('inside double quotes the unquoted form is inserted; inside single quotes the quotes close and reopen', () => {
    expect(project('"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" a', 'claude').rendered).toMatch(
      / "\$CLAUDE_PROJECT_DIR\/\.palm\/assets\/acme__kit\/fmt\/plugins\/fmt\/hooks\/run\.sh" a$/,
    );
    expect(project("sh -c '${CLAUDE_PLUGIN_ROOT}/hooks/run.sh'", 'claude').rendered).toMatch(
      /sh -c ''"\$CLAUDE_PROJECT_DIR"\/\.palm\/assets\/acme__kit\/fmt\/plugins\/fmt\/hooks\/run\.sh''$/,
    );
  });

  it('a path with characters the shell reads is quoted whole', () => {
    const ref = { ...REL_REF, raw: './my script.sh', rel: 'hooks/my script.sh' };
    const r = project('bash "./my script.sh"', 'claude', [ref]);
    expect(r.rendered).toBe(
      'bash "$CLAUDE_PROJECT_DIR/.palm/assets/acme__kit/fmt/hooks/my script.sh"',
    );
  });
});

describe('relative paths and the canonical form', () => {
  it('a relative path becomes ${PLUGIN_ROOT}/<rel> in the canonical form; no export without a root token', () => {
    const r = project('bash ./scripts/check.sh', 'claude', [REL_REF]);
    expect(r.canonical).toBe('bash ${PLUGIN_ROOT}/plugins/fmt/hooks/scripts/check.sh');
    expect(r.rendered).toBe(
      'bash "$CLAUDE_PROJECT_DIR"/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/scripts/check.sh',
    );
  });

  it('only whole words match: a longer path is left alone', () => {
    const r = project('bash ./scripts/check.sh.bak', 'claude', [REL_REF]);
    expect(r.rendered).toBe('bash ./scripts/check.sh.bak');
  });

  it('the canonical form is the same for every target', () => {
    const canon = (['claude', 'codex', 'cursor', 'gemini', 'copilot'] as const).map(
      (t) =>
        project('${CLAUDE_PLUGIN_ROOT}/hooks/run.sh && ./scripts/check.sh', t, [ROOT_REF, REL_REF])
          .canonical,
    );
    expect(new Set(canon).size).toBe(1);
  });
});

describe('global scope', () => {
  it('"$HOME"-relative, never an absolute path', () => {
    const r = global('${CLAUDE_PLUGIN_ROOT}/hooks/run.sh');
    expect(r.rendered).toBe(
      'CLAUDE_PLUGIN_ROOT="$HOME"/.palm/assets/acme__kit/fmt/plugins/fmt "$HOME"/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/run.sh',
    );
    expect(r.rendered).not.toContain(HOME);
  });

  it('a PALM_HOME other than ~/.palm is written as ${PALM_HOME:-$HOME/.palm}', () => {
    expect(
      global('${CLAUDE_PLUGIN_ROOT}/hooks/run.sh', { HOME, PALM_HOME: '/opt/palm' }).rendered,
    ).toBe(
      'CLAUDE_PLUGIN_ROOT="${PALM_HOME:-$HOME/.palm}"/assets/acme__kit/fmt/plugins/fmt "${PALM_HOME:-$HOME/.palm}"/assets/acme__kit/fmt/plugins/fmt/hooks/run.sh',
    );
    expect(
      global('${CLAUDE_PLUGIN_ROOT}/hooks/run.sh', { HOME, PALM_HOME: `${HOME}/.palm` }).rendered,
    ).toContain('"$HOME"/.palm/assets/');
  });
});

describe('in-place local sources', () => {
  it('project: the source directory itself, so a script edit is live', () => {
    const ref = { ...REL_REF, raw: './quality.sh', rel: 'hooks/quality.sh' };
    const r = relocateCommand('bash ./quality.sh', [ref], 'claude', {
      assetsRoot: 'agent-kit',
      scope: 'project',
    });
    expect(r.rendered).toBe('bash "$CLAUDE_PROJECT_DIR"/agent-kit/hooks/quality.sh');
  });

  it('global: a source under the palm home or the home directory', () => {
    const ref = { ...REL_REF, raw: './quality.sh', rel: 'hooks/quality.sh' };
    const at = (assetsRoot: string) =>
      relocateCommand('bash ./quality.sh', [ref], 'codex', {
        assetsRoot,
        scope: 'global',
        env: { HOME },
      }).rendered;
    expect(at('<palm>/kit')).toBe('bash "$HOME"/.palm/kit/hooks/quality.sh');
    expect(at('<home>/dotfiles/kit')).toBe('bash "$HOME"/dotfiles/kit/hooks/quality.sh');
  });
});

describe('what palm never merges', () => {
  it('an unresolved reference names the offending text', () => {
    const bad: SourceReference = {
      raw: './gone.sh',
      form: 'relative',
      site: 'command',
      unresolved: 'no such file',
    };
    expect(() => project('bash ./gone.sh', 'claude', [bad])).toThrow(
      expect.objectContaining({
        code: 'E_SOURCE',
        message: expect.stringContaining('"./gone.sh"'),
      }),
    );
  });

  it('a plugin-root token that no reference covers', () => {
    expect(() => project('${CLAUDE_PLUGIN_ROOT}/other.sh', 'claude', [])).toThrow(
      expect.objectContaining({ code: 'E_SOURCE' }),
    );
  });

  it('PowerShell gets the path without a POSIX export', () => {
    const r = relocateCommand('& "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"', [ROOT_REF], 'claude', {
      assetsRoot: ASSETS,
      scope: 'project',
      powershell: true,
    });
    expect(r.rendered).toBe(
      '& "$CLAUDE_PROJECT_DIR/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/run.sh"',
    );
  });
});

describe('MCP servers', () => {
  const server: McpServerConfig = {
    name: 'local',
    transport: 'stdio',
    command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
    args: ['--config', '${CLAUDE_PLUGIN_ROOT}/conf.json'],
    cwd: '${CLAUDE_PLUGIN_ROOT}',
  };
  const refs: SourceReference[] = [
    {
      raw: '${CLAUDE_PLUGIN_ROOT}/bin/server',
      form: 'plugin-root',
      site: 'command',
      rel: 'p/bin/server',
    },
    {
      raw: '${CLAUDE_PLUGIN_ROOT}/conf.json',
      form: 'plugin-root',
      site: 'args',
      rel: 'p/conf.json',
    },
    { raw: '${CLAUDE_PLUGIN_ROOT}', form: 'plugin-root', site: 'cwd', rel: 'p' },
  ];

  it('project: command, args and cwd become project-relative asset paths', () => {
    const r = relocateMcp(server, refs, 'claude', { assetsRoot: ASSETS, scope: 'project' });
    expect(r.cfg).toMatchObject({
      command: `${ASSETS}/p/bin/server`,
      args: ['--config', `${ASSETS}/p/conf.json`],
      cwd: `${ASSETS}/p`,
    });
    expect(r.canonical).toBe(
      '${CLAUDE_PLUGIN_ROOT}/bin/server --config ${CLAUDE_PLUGIN_ROOT}/conf.json',
    );
    expect(r.rendered).toBe(`${ASSETS}/p/bin/server --config ${ASSETS}/p/conf.json`);
  });

  it('global: the home directory in each harness syntax; codex (no expansion) gets the absolute path', () => {
    const opts = {
      assetsRoot: '<palm>/assets/acme__kit/local',
      scope: 'global' as const,
      absolute: (p: string) => p.replace('<palm>', `${HOME}/.palm`),
      home: HOME,
    };
    const cmd = (t: TargetId) => relocateMcp(server, refs, t, opts).cfg.command;
    expect(cmd('claude')).toBe('${HOME}/.palm/assets/acme__kit/local/p/bin/server');
    expect(cmd('cursor')).toBe('${userHome}/.palm/assets/acme__kit/local/p/bin/server');
    expect(cmd('opencode')).toBe('{env:HOME}/.palm/assets/acme__kit/local/p/bin/server');
    expect(cmd('codex')).toBe(`${HOME}/.palm/assets/acme__kit/local/p/bin/server`);
  });
});
