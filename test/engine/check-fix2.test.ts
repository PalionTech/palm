/**
 * The second persona-rerun rulings for `palm check` (scratchpad FINDINGS-v3.md), one test per id.
 */
import './fakes.js';

import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { CheckRun, LockEntry } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { fragmentKey } from '../../src/domain/merged-record.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { checkScope } from '../../src/engine/check.js';
import { installFromSource } from '../../src/engine/install.js';
import { setGitRunner } from '../../src/lib/git-query.js';
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

describe("S6 J16' S7 secrets by server", () => {
  const fill = (n: number) => 'Zx8kQ2mN7pL4vR9tW3yB6cF1'.repeat(4).slice(0, n);

  it("S6 J16' a literal is blamed on the server that holds it; a hand-written server is foreign", async () => {
    const { w } = await world(['local']);
    const token = `ghp_${fill(36)}`;
    const servers = {
      mcpServers: {
        local: { command: 'node', args: ['server.js'], env: { LOCAL_API_KEY: fill(24) } },
        handmade: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: token } },
      },
    };
    await w.write('.claude/mcp.json', JSON.stringify(servers));
    await chmod(w.path('.claude/mcp.json'), 0o644);
    const { r } = await check(w);
    expect(r.secrets?.status).toBe('fail');
    const problems = r.secrets?.problems ?? [];
    expect(problems).toContainEqual(
      expect.objectContaining({
        entity: expect.objectContaining({ name: 'local' }),
        message:
          '.claude/mcp.json holds a literal secret (.claude/mcp.json:mcpServers.local.env.LOCAL_API_KEY), readable by others',
      }),
    );
    const foreign = problems.find((p) => p.message.startsWith('foreign server handmade'));
    expect(foreign?.entity).toBeUndefined();
    expect(foreign?.message).toBe(
      'foreign server handmade in .claude/mcp.json holds a literal secret (.claude/mcp.json:mcpServers.handmade.env.GITHUB_TOKEN), readable by others',
    );
    expect(JSON.stringify(problems)).not.toContain(token);
  });

  it("S7 J16' a source server's redacted literal is a variable it needs; the warning stays a warning", async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const url = await w.remote('kit', {
      'v1.0.0': {
        'mcp.json': JSON.stringify({
          remote: {
            transport: 'http',
            url: 'https://mcp.example/v1',
            headers: { 'X-Api-Key': '<redacted sha256:1a2b3c4d>' },
          },
        }),
      },
    });
    const r0 = await installFromSource(
      w.ctx,
      { source: url, names: [{ kind: 'mcp', name: 'remote' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r0.failures).toEqual([]);
    const { r } = await check(w);
    expect(r.variables?.status).toBe('warn');
    expect(messages(r.variables)).toBe('needs REMOTE_API_KEY, which is not set');
    expect(r.secrets?.problems.some((p) => p.message.startsWith('needs'))).toBe(false);
  });
});

describe('B2 targets dropped from palm.yaml', () => {
  it('B2 check fails naming the target and how many files the next install removes', async () => {
    const w = await makeWorld({ targets: ['claude', 'codex'], interactive: true, consent: 'yes' });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    const r0 = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r0.failures).toEqual([]);
    expect((await check(w)).r.targets?.status).toBe('ok');
    const text = (await w.manifestText()) ?? '';
    await w.write('palm.yaml', text.replace('targets: [claude, codex]', 'targets: [claude]'));
    const { r, report } = await check(w);
    expect(r.targets?.status).toBe('fail');
    expect(r.targets?.problems[0]?.message).toBe(
      'codex removed from targets in palm.yaml: 1 file is removed by the next palm install',
    );
    expect(report.ok).toBe(false);
  });
});

describe('X5 T8 M3 git-ignored asks git about real paths and names exact directories', () => {
  afterEach(() => setGitRunner(undefined));

  function git(w: World, tracked: (path: string) => boolean) {
    setGitRunner(async (args) => {
      if (args[0] === 'rev-parse') return `${w.project}\n`;
      if (args[0] === 'ls-files') return tracked(String(args.at(-1))) ? `${args.at(-1)}\n` : '';
      throw new Error('not ignored');
    });
  }

  it('X5 T8 a file behind a committed link counts as the file git holds', async () => {
    const { w } = await world(['tdd']);
    await mkdir(w.path('.agents'), { recursive: true });
    await rename(w.path('.claude/skills'), w.path('.agents/skills'));
    await symlink('../.agents/skills', w.path('.claude/skills'));
    git(w, (p) => p.includes('/.agents/'));
    expect((await check(w)).r['git-ignored']?.status).toBe('ok');
    git(w, () => false);
    const { r } = await check(w);
    expect(r['git-ignored']?.problems[0]?.fix).toBe('git add .agents/skills');
  });

  it('M3 the git add fix names the output directories, never the harness root', async () => {
    const { w } = await world(['tdd', 'guard']);
    git(w, () => false);
    const { r } = await check(w);
    const fix = r['git-ignored']?.problems[0]?.fix ?? '';
    expect(fix).toMatch(/^git add /);
    expect(fix.split(' ')).toContain('.claude/skills');
    expect(fix.split(' ')).not.toContain('.claude');
  });
});

describe("T7 Y2' partial reuses the refusal's hint", () => {
  it("T7 Y2' the fix for a target the render refuses is the refusal's hint, not palm install", async () => {
    const w = await makeWorld({ targets: ['claude', 'cursor'], interactive: true, consent: 'yes' });
    const getTarget = w.deps.getTarget as NonNullable<World['deps']['getTarget']>;
    w.deps.getTarget = (id) => {
      const t = getTarget(id);
      if (id !== 'cursor') return t;
      const refuse = () => {
        throw new PalmError(
          'E_TARGET',
          'too large for cursor',
          'edit palm.yaml: targets: [claude]',
        );
      };
      return { ...t, render: async () => refuse() };
    };
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    const { r } = await check(w);
    expect(r.partial?.problems[0]).toMatchObject({
      message: 'skill tdd is not installed for cursor',
      fix: 'edit palm.yaml: targets: [claude]',
    });
  });
});

describe('X4 source-paths per entity', () => {
  it('X4 files of one entity inside a source are one line with a count', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const files = {
      'skills/big/SKILL.md': 'Big.\n',
      'skills/big/a.md': 'a\n',
      'skills/big/b.md': 'b\n',
    };
    const url = await w.remote('big', { 'v1.0.0': files });
    const src = await w.local('skill', { 'skills/mine/SKILL.md': 'mine\n' });
    for (const [source, name] of [
      [url, 'big'],
      [src, 'mine'],
    ] as const) {
      const r0 = await installFromSource(
        w.ctx,
        { source, names: [{ name }] },
        { scope: 'project' },
        w.deps,
      );
      expect(r0.failures).toEqual([]);
    }
    await rename(w.path('.claude/skills/big'), w.path('skill/big'));
    await w.remove('.claude/skills');
    await symlink('../skill', w.path('.claude/skills'));
    const { r } = await check(w);
    expect(messages(r['source-paths'])).toContain(
      '3 files of skill big lie inside the declared source skill (.claude/skills/big/SKILL.md, …); palm never deletes inside a source',
    );
  });
});

describe('X13 M9 one entity in two scopes', () => {
  it('X13 M9 a skill installed in the project and with -g warns in both checks', async () => {
    const { w, url } = await world(['tdd']);
    await mkdir(w.palmHome, { recursive: true });
    await writeFile(join(w.palmHome, 'palm.yaml'), 'targets: [claude]\n');
    const global = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'global' },
      w.deps,
    );
    expect(global.failures).toEqual([]);
    const { r } = await check(w);
    expect(r['double-load']?.status).toBe('warn');
    expect(r['double-load']?.problems[0]).toMatchObject({
      message:
        'skill tdd is installed here and globally (-g); a harness that reads both lists it twice',
      fix: 'keep one: palm remove kit skill:tdd -g, or remove it here',
    });
    const g = await checkScope(w.ctx, { scope: 'global' }, w.deps);
    const twice = g.checks.find((x) => x.id === 'double-load');
    expect(twice?.problems[0]?.message).toContain('is installed here and in this project');
  });
});

describe("Y12' R6' check without palm.yaml", () => {
  afterEach(() => setGitRunner(undefined));

  it("Y12' R6' fails with no palm.yaml here and still finds a key in a tracked harness config", async () => {
    const w = await makeWorld({ interactive: false });
    const key = `ghp_${'Zx8kQ2mN7pL4vR9tW3yB6cF1'.repeat(2).slice(0, 36)}`;
    const servers = { mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: key } } } };
    await w.write('.cursor/mcp.json', JSON.stringify(servers));
    setGitRunner(async (args) => {
      if (args[0] === 'rev-parse') return `${w.project}\n`;
      if (args[0] === 'ls-files') return `${String(args.at(-1))}\n`;
      throw new Error('not ignored');
    });
    const { r, report } = await check(w);
    expect(report.ok).toBe(false);
    expect(r['manifest-lock']).toMatchObject({
      status: 'fail',
      label: 'no palm.yaml here',
      problems: [{ message: 'no palm.yaml here', fix: 'palm init' }],
    });
    expect(r.secrets?.status).toBe('fail');
    expect(messages(r.secrets)).toContain('.cursor/mcp.json:mcpServers.gh.env.GITHUB_TOKEN');
    expect(messages(r.secrets)).not.toContain(key);
    expect(r['lock-disk']?.status).toBe('skipped');
    expect(report.checks.map((c) => c.id)).toContain('foreign-servers');
  });
});

describe("E6' an item palm wrote earlier is palm's after a render move", () => {
  it("E6' a hook item the lock records by key is never foreign, whatever palm renders now", async () => {
    const { w } = await world(['guard']);
    const old = {
      matcher: '',
      hooks: [{ type: 'command', command: 'bash "$CURSOR_PROJECT_DIR"/old/guard.sh' }],
    };
    const lock = await Lock.load(w.path('palm.lock.yaml'));
    const guard = lock.find({ kind: 'hook', name: 'guard' }, 'kit') as LockEntry;
    const record = {
      file: '.claude/settings.json',
      at: '/hooks/Stop',
      id: 'palm:hook:guard:1',
      key: fragmentKey('/hooks/Stop', old),
    };
    await lock
      .upsert({ ...guard, merged: [...(guard.merged ?? []), record] })
      .save(w.path('palm.lock.yaml'));
    await handAdded(w, {});
    const settings = JSON.parse((await w.read('.claude/settings.json')) ?? '{}');
    settings.hooks.Stop.push(old, command('echo mine')[0]);
    await w.write('.claude/settings.json', JSON.stringify(settings));
    const { r } = await check(w);
    expect(messages(r['foreign-hooks'])).toBe(
      'foreign hook command in .claude/settings.json (Stop): echo mine',
    );
  });
});

describe("E3' a stale process lock", () => {
  it("E3' check removes a lock a dead process of this host left; a live one stays", async () => {
    const { w } = await world(['tdd']);
    const file = ScopePaths.of(w.ctx, 'project').processLock;
    const write = (pid: number) =>
      mkdir(dirname(file), { recursive: true }).then(() =>
        writeFile(file, JSON.stringify({ pid, host: hostname(), createdAt: 'x' })),
      );
    await write(2 ** 22 + 12345);
    await check(w);
    expect(existsSync(file)).toBe(false);
    await write(process.pid);
    await check(w);
    expect(existsSync(file)).toBe(true);
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
