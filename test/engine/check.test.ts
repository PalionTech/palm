import './fakes.js';

import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckReport, CheckRun } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { checkScope } from '../../src/engine/check.js';
import { installFromSource } from '../../src/engine/install.js';
import { setGitRunner } from '../../src/lib/git-query.js';
import { makeWorld, type World } from './world.js';

const IDS = [
  'manifest-lock',
  'lock-disk',
  'local-sources',
  'exec-trusted',
  'hook-scripts',
  'secrets',
  'git-ignored',
  'sources-declared',
  'links',
  'hidden-unicode',
  'double-load',
  'block-size',
];

const KIT = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'hooks/guard/hooks.json': JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/guard/run.sh' }] }],
    },
  }),
  'hooks/guard/run.sh': { text: 'echo guard\n', mode: 0o755 },
  'mcp.json': JSON.stringify({
    docs: {
      transport: 'http',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    },
  }),
};

async function installed(): Promise<World> {
  const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
  const url = await w.remote('kit', { 'v1.0.0': KIT });
  const src = await w.local('agent-kit', { 'skills/local/SKILL.md': 'mine\n' });
  const a = await installFromSource(
    w.ctx,
    { source: url, names: [{ name: 'tdd' }, { name: 'guard' }, { kind: 'mcp', name: 'docs' }] },
    { scope: 'project' },
    w.deps,
  );
  const b = await installFromSource(
    w.ctx,
    { source: src, names: [{ name: 'local' }] },
    { scope: 'project' },
    w.deps,
  );
  expect([...a.failures, ...b.failures]).toEqual([]);
  return w;
}

function byId(report: CheckReport): Record<string, CheckRun> {
  return Object.fromEntries(report.checks.map((c) => [c.id, c]));
}

async function check(w: World): Promise<Record<string, CheckRun>> {
  const report = await checkScope(w.ctx, { scope: 'project' }, w.deps);
  expect(report.checks.map((c) => c.id)).toEqual(IDS);
  return byId(report);
}

afterEach(() => setGitRunner(undefined));

describe('checkScope', () => {
  it('runs every check and passes on a scope that agrees', async () => {
    const w = await installed();
    const env = { ...w.ctx.env, DOCS_TOKEN: 'set' };
    const report = await checkScope({ ...w.ctx, env }, { scope: 'project' }, w.deps);
    expect(report.checks.map((c) => c.id)).toEqual(IDS);
    expect(report.checks.filter((c) => c.status !== 'ok' && c.status !== 'skipped')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(byId(report)['git-ignored']).toMatchObject({
      status: 'skipped',
      label: expect.stringContaining('skipped (not a git repository)'),
    });
  });

  it('fails manifest-lock on an entry palm.yaml has and the lock lacks', async () => {
    const w = await installed();
    const m = await Manifest.load(w.path('palm.yaml'));
    await m.addEntry('kit', 'skill', 'review').save(w.path('palm.yaml'));
    const r = await check(w);
    expect(r['manifest-lock']).toMatchObject({
      status: 'fail',
      problems: [{ fix: 'palm install' }],
    });
  });

  it('fails lock-disk on a missing and on an edited file', async () => {
    const w = await installed();
    await w.remove('.claude/skills/tdd/SKILL.md');
    await w.write('.claude/skills/local/SKILL.md', 'edited\n');
    const r = await check(w);
    expect(r['lock-disk']?.status).toBe('fail');
    const messages = r['lock-disk']?.problems.map((p) => p.message).join('\n');
    expect(messages).toContain('.claude/skills/tdd/SKILL.md is missing');
    expect(messages).toContain('.claude/skills/local/SKILL.md differs');
  });

  it('fails local-sources when an in-repo source changed since the lock', async () => {
    const w = await installed();
    await w.write('agent-kit/skills/local/SKILL.md', 'changed\n');
    const r = await check(w);
    expect(r['local-sources']?.status).toBe('fail');
    expect(r['local-sources']?.problems[0]?.message).toMatch(
      /skill local in source \.\/agent-kit changed since palm\.lock\.yaml \(content \w+ → \w+\)/,
    );
    expect(r['lock-disk']?.status).toBe('ok');
  });

  it('fails exec-trusted when the lock does not trust a unit', async () => {
    const w = await installed();
    const lock = await Lock.load(w.path('palm.lock.yaml'));
    const guard = lock.find({ kind: 'hook', name: 'guard' }, 'kit');
    await lock
      .upsert({ ...(guard as NonNullable<typeof guard>), trust: [] })
      .save(w.path('palm.lock.yaml'));
    const r = await check(w);
    expect(r['exec-trusted']).toMatchObject({
      status: 'fail',
      problems: [{ fix: expect.stringContaining('--allow-exec hook:guard@kit=sha256:') }],
    });
  });

  it('fails hook-scripts when a script a hook runs is gone', async () => {
    const w = await installed();
    await w.remove('.palm/assets/kit/guard/hooks/guard/run.sh');
    const r = await check(w);
    expect(r['hook-scripts']?.status).toBe('fail');
    expect(r['hook-scripts']?.problems[0]?.message).toContain('does not exist');
  });

  it('fails secrets on a literal in a world-readable file and warns on an unset variable', async () => {
    const w = await installed();
    const file = w.path('.claude/mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        '/mcpServers/docs#docs': {
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer sk-abcdefghijklmnop' },
        },
      }),
    );
    await chmod(file, 0o644);
    const r = await check(w);
    expect(r.secrets?.status).toBe('fail');
    expect(r.secrets?.problems.map((p) => p.message).join('\n')).toContain('readable by others');
    expect(r.secrets?.problems.map((p) => p.fix)).toContain('export DOCS_TOKEN=…');
  });

  it('fails git-ignored when an output directory is ignored by git', async () => {
    const w = await installed();
    setGitRunner(async (args) => {
      if (args[0] === 'rev-parse') return `${w.project}\n`;
      if (args[0] === 'check-ignore' && String(args.at(-1)).includes('/.claude/')) return '';
      if (args[0] === 'ls-files') return `${String(args.at(-1))}\n`;
      throw new Error('not ignored');
    });
    const r = await check(w);
    expect(r['git-ignored']).toMatchObject({ status: 'fail', problems: [{ file: '.claude' }] });
    expect(r['git-ignored']?.problems[0]?.message).toMatch(
      /^\d+ files under \.claude\/ \(.+\) are ignored by git/,
    );
  });

  it('fails sources-declared when a declared local source is missing', async () => {
    const w = await installed();
    await w.remove('agent-kit');
    const r = await check(w);
    expect(r['sources-declared']).toMatchObject({
      status: 'fail',
      problems: [{ fix: 'restore the directory agent-kit' }],
    });
  });

  it('fails links when a generated path resolves outside the scope', async () => {
    const w = await installed();
    await w.remove('.claude/skills/tdd/SKILL.md');
    await writeFile(join(w.root, 'outside.md'), 'elsewhere\n');
    await symlink(join(w.root, 'outside.md'), w.path('.claude/skills/tdd/SKILL.md'));
    const r = await check(w);
    expect(r.links?.status).toBe('fail');
    expect(r.links?.problems[0]?.message).toContain('outside the scope');
  });

  it('fails hidden-unicode on a bidi override in a generated file', async () => {
    const w = await installed();
    await w.write('.claude/skills/tdd/SKILL.md', 'Test‮ first.\n');
    const r = await check(w);
    expect(r['hidden-unicode']?.status).toBe('fail');
  });

  it('warns on a double load and fails a block above the harness cap', async () => {
    const w = await makeWorld({ targets: ['claude', 'cursor'] });
    await w.write('AGENTS.md', 'x'.repeat(40 * 1024));
    const lock = new Lock({ kit: { path: 'kit' } }, [
      {
        kind: 'skill',
        name: 'tdd',
        source: 'kit',
        path: 'skills/tdd',
        content: 'sha256:0',
        render: {},
        files: ['.agents/skills/tdd/SKILL.md', '.claude/skills/tdd/SKILL.md'],
      },
      {
        kind: 'instruction',
        name: 'style',
        source: 'kit',
        path: 'instructions/style.md',
        content: 'sha256:0',
        render: {},
        files: ['.cursor/rules/style.mdc'],
        merged: [
          {
            file: 'AGENTS.md',
            at: 'block:instruction:style',
            id: 'palm:instruction:style:0',
            key: 'instruction:style',
          },
        ],
      },
    ]);
    await lock.save(w.path('palm.lock.yaml'));
    const r = await check(w);
    expect(r['double-load']?.status).toBe('warn');
    expect(r['double-load']?.problems.map((p) => p.message)).toEqual([
      'cursor loads instruction style twice (AGENTS.md and .cursor/rules)',
    ]);
    expect(r['block-size']?.status).toBe('fail');
  });
});
