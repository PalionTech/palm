/**
 * The second persona-rerun rulings for `palm check` (scratchpad FINDINGS-v3.md), one test per id.
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../../src/core/types.js';
import { checkScope } from '../../src/engine/check.js';
import { installFromSource } from '../../src/engine/install.js';
import { remotes } from './fakes.js';
import { makeWorld, type World } from './world.js';

const HOOKS = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/guard/run.sh' }] }],
  },
};

const KIT = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'hooks/guard/hooks.json': JSON.stringify(HOOKS),
  'hooks/guard/run.sh': { text: 'echo guard\n', mode: 0o755 },
  'mcp.json': JSON.stringify({
    local: { transport: 'stdio', command: 'node', args: ['server.js'] },
  }),
};

async function world(names: string[]): Promise<{ w: World; url: string }> {
  const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
  const url = await w.remote('kit', { 'v1.0.0': KIT });
  const r = await installFromSource(
    w.ctx,
    { source: url, names: names.map((name) => ({ name })) },
    { scope: 'project' },
    w.deps,
  );
  expect(r.failures).toEqual([]);
  return { w, url };
}

async function check(w: World, opts: { strict?: boolean; offline?: boolean } = {}) {
  const ctx = { ...w.ctx, flags: { ...w.ctx.flags, offline: !!opts.offline } };
  const report = await checkScope(ctx, { scope: 'project', strict: !!opts.strict }, w.deps);
  const r = Object.fromEntries(report.checks.map((c) => [c.id, c])) as Record<string, CheckRun>;
  return { report, r };
}

function messages(run: CheckRun | undefined): string {
  return (run?.problems ?? []).map((p) => p.message).join('\n');
}

/** `.claude/settings.json` with palm's Stop command kept and hand-added hooks beside it. */
async function handAdded(w: World, extra: Record<string, unknown[]>): Promise<void> {
  const guard = await w.entry('hook', 'guard');
  const palm = guard?.exec?.commands[0]?.command as string;
  const hooks = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: palm }] }], ...extra };
  await w.write('.claude/settings.json', JSON.stringify({ hooks }));
}

const command = (text: string) => [
  { matcher: 'Bash', hooks: [{ type: 'command', command: text }] },
];

describe("Sofia S2 V2' foreign programs in every harness file palm parses", () => {
  it("Sofia S2 V2' a hand-added hook under another event and a foreign stdio server warn", async () => {
    const { w } = await world(['guard']);
    await w.write('tools/audit.sh', 'echo audit\n');
    await handAdded(w, { PreToolUse: command('bash ./tools/audit.sh') });
    const servers = {
      mcpServers: {
        rogue: { command: 'node', args: ['tools/rogue.js'] },
        remote: { type: 'http', url: 'https://mcp.example/v1' },
      },
    };
    await w.write('.mcp.json', JSON.stringify(servers));
    const { r, report } = await check(w);
    expect(r['foreign-hooks']?.status).toBe('warn');
    expect(messages(r['foreign-hooks'])).toBe(
      'foreign hook command in .claude/settings.json (PreToolUse): bash ./tools/audit.sh',
    );
    expect(r['foreign-servers']?.status).toBe('warn');
    expect(messages(r['foreign-servers'])).toBe(
      'foreign stdio server rogue in .mcp.json: node tools/rogue.js; script missing: tools/rogue.js',
    );
    expect(r['exec-trusted']?.status).toBe('ok');
    expect(report.checks.find((c) => c.id === 'foreign-hooks')?.problems[0]?.fix).toBe(
      'keep it if you added it; else remove it from .claude/settings.json (palm does not manage it)',
    );
  });

  it("Sofia S2 V2' check --strict fails on a foreign hook command and a foreign stdio server", async () => {
    const { w } = await world(['guard']);
    await handAdded(w, { SessionStart: command('echo hi') });
    await w.write('.mcp.json', JSON.stringify({ mcpServers: { rogue: { command: 'npx' } } }));
    const { r, report } = await check(w, { strict: true });
    expect(r['foreign-hooks']?.status).toBe('fail');
    expect(r['foreign-servers']?.status).toBe('fail');
    expect(r['exec-trusted']?.status).toBe('ok');
    expect(report.ok).toBe(false);
  });

  it("Sofia S2 palm's own stdio server and hook commands are never foreign", async () => {
    const { w } = await world(['guard', 'local']);
    await handAdded(w, {});
    const own = { command: 'node', args: ['server.js'] };
    const servers = { mcpServers: { local: own, rogue: { command: 'uvx', args: ['rogue'] } } };
    await w.write('.claude/mcp.json', JSON.stringify(servers));
    const { r } = await check(w, { strict: true });
    expect(r['foreign-hooks']?.status).toBe('ok');
    expect(messages(r['foreign-servers'])).toBe(
      'foreign stdio server rogue in .claude/mcp.json: uvx rogue',
    );
  });

  it('X14 a foreign hook whose script is missing says so', async () => {
    const { w } = await world(['guard']);
    await w.write('.claude/hooks/present.sh', 'echo here\n');
    await handAdded(w, {
      PreToolUse: [
        ...command('"$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.sh'),
        ...command('"$CLAUDE_PROJECT_DIR"/.claude/hooks/present.sh'),
      ],
    });
    const { r } = await check(w);
    expect(messages(r['foreign-hooks'])).toBe(
      [
        'foreign hook command in .claude/settings.json (PreToolUse): "$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.sh; script missing: .claude/hooks/gone.sh',
        'foreign hook command in .claude/settings.json (PreToolUse): "$CLAUDE_PROJECT_DIR"/.claude/hooks/present.sh',
      ].join('\n'),
    );
  });
});

describe("O12 X2 B5 E4' a check that did not run", () => {
  it("O12 X2 B5 E4' a cold cache offline is never ✓, --quiet has a line for it, --strict fails", async () => {
    const { w, url } = await world(['tdd']);
    const remote = remotes.get(url) as { trees: Record<string, string | undefined> };
    for (const sha of Object.keys(remote.trees)) delete remote.trees[sha];
    const { r, report } = await check(w, { offline: true });
    expect(r['lock-disk']?.status).toBe('skipped');
    expect(r['lock-disk']?.problems).toEqual([
      { message: 'lock-disk did not run: cache empty', fix: 'palm install' },
    ]);
    expect(report.ok).toBe(true);
    const strict = await check(w, { offline: true, strict: true });
    expect(strict.r['lock-disk']?.status).toBe('fail');
    expect(strict.r['lock-disk']?.label).toContain('--strict fails on a check that did not run');
    expect(strict.r.pending?.status).toBe('skipped');
    expect(strict.report.ok).toBe(false);
  });

  it('X2 entities skipped offline beside checked ones make lock-disk skipped, not ✓', async () => {
    const { w } = await world(['tdd']);
    const other = await w.remote('other', { 'v1.0.0': { 'skills/lint/SKILL.md': 'Lint.\n' } });
    const r2 = await installFromSource(
      w.ctx,
      { source: other, names: [{ name: 'lint' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r2.failures).toEqual([]);
    const remote = remotes.get(other) as { trees: Record<string, string | undefined> };
    for (const sha of Object.keys(remote.trees)) delete remote.trees[sha];
    const { r } = await check(w, { offline: true });
    expect(r['lock-disk']).toMatchObject({
      status: 'skipped',
      label: 'generated files: 1 entity not checked (cache empty)',
    });
    expect(messages(r['lock-disk'])).toBe(
      'lock-disk did not run for 1 entity not checked (cache empty)',
    );
  });
});
