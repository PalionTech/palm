import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LockEntry, PalmContext } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { outdatedEntries, refLabel } from '../../src/engine/outdated.js';
import { runInProcess } from '../cli/helpers.js';
import { makeRemote } from '../core/gitrepo.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox, writeFiles } from '../support/sandbox.js';

function entry(name: string, over: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: 'skill',
    name,
    origin: 'r',
    path: `skills/${name}`,
    contentHash: 'sha256:0',
    transform: 1,
    targets: ['claude'],
    files: [],
    ...over,
  };
}

describe('palm outdated', () => {
  let sb: Sandbox;
  let ctx: PalmContext;
  let shas: Record<string, string>;
  let url: string;
  beforeEach(async () => {
    sb = await sandbox();
    const remote = await makeRemote(sb.root); // v1.0.0, v1.1.0, v2.0.0-beta.1, main
    shas = remote.shas;
    url = remote.bare;
    await writeFiles(join(sb.root, 'local'), { 'skills/mine/SKILL.md': 'mine\n' });
    ctx = await makeContext(sb);
    ctx.config.origins.push(
      { alias: 'r', type: 'git', url },
      { alias: 'loc', type: 'local', path: join(sb.root, 'local') },
    );
    const at = (tag: string) => ({ url, ref: tag, sha: shas[tag] });
    await new Lock([
      entry('ranged', at('v1.0.0')),
      entry('exact', at('v1.0.0')),
      entry('fresh', at('v1.1.0')),
      entry('branch', at('main')),
      entry('member', { ...at('v1.0.0'), via: 'plugin:bundle' }),
      entry('mine', { origin: 'loc' }),
      entry('ghost', { origin: 'gone', ref: 'v1', sha: 'a'.repeat(40) }),
      entry('fs', { kind: 'mcp', origin: 'adhoc', path: 'fs' }),
    ]).save(join(sb.project, 'palm.lock.yaml'));
    await Manifest.of({
      targets: ['claude'],
      skills: ['ranged@r#^1.0', 'exact@r#v1.0.0', 'fresh@r', 'branch@r#main', 'mine@loc'],
      mcp: [{ name: 'fs', command: 'npx', args: ['fs'] }],
    }).save(join(sb.project, 'palm.yaml'));
  });
  afterEach(async () => removeDir(sb.root));

  it('current / wanted / latest from remote refs: ranges, exact pins, branches, local and ad hoc', async () => {
    const r = await outdatedEntries(ctx, { scope: 'project' });
    const rows = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(Object.keys(rows)).toEqual([
      'branch',
      'exact',
      'fresh',
      'ghost',
      'mine',
      'ranged',
      'fs',
    ]);
    const short = (tag: string) => `${tag} (${shas[tag]!.slice(0, 7)})`;
    expect(rows.ranged).toMatchObject({
      current: short('v1.0.0'),
      wanted: short('v1.1.0'), // ^1.0 → newest matching release; v2.0.0-beta.1 does not qualify
      latest: short('v1.1.0'),
      status: 'outdated',
    });
    expect(rows.exact).toMatchObject({
      wanted: short('v1.0.0'),
      latest: short('v1.1.0'),
      status: 'pinned',
    });
    expect(rows.fresh).toMatchObject({
      current: short('v1.1.0'),
      wanted: short('v1.1.0'),
      status: 'current',
    });
    // ls-remote reports the branch's head commit: the locked one is compared with it (same
    // commit, but palm.yaml pins the branch while a release exists: pinned)
    expect(rows.branch).toMatchObject({ wanted: short('main'), status: 'pinned' });
    expect(rows.mine).toMatchObject({ status: 'untracked', wanted: '-' });
    expect(rows.fs).toMatchObject({ kind: 'mcp', status: 'untracked' });
    expect(rows.ghost).toMatchObject({ status: 'unknown', wanted: '?' });
    expect(r.warnings.some((w) => w.includes('origin "gone" is not registered'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('branch-tracking'))).toBe(false);

    const skills = await outdatedEntries(ctx, { scope: 'project', kind: 'mcp' });
    expect(skills.items.map((i) => i.name)).toEqual(['fs']);
  });

  it('compares a branch by commit when the remote reports head commits', async () => {
    const remote = {
      refs: async () => ({ tags: [], heads: ['main'], headShas: { main: 'f'.repeat(40) } }),
      latest: async () => 'main',
    };
    const r = await outdatedEntries(ctx, { scope: 'project', remote });
    const branch = r.items.find((i) => i.name === 'branch');
    expect(branch).toMatchObject({ wanted: 'main (fffffff)', status: 'outdated' });
    const same = {
      ...remote,
      refs: async () => ({ tags: [], heads: ['main'], headShas: { main: shas.main! } }),
    };
    const again = await outdatedEntries(ctx, { scope: 'project', remote: same });
    expect(again.items.find((i) => i.name === 'branch')?.status).toBe('current');
    // a reader that knows no commits: the branch cannot be compared
    const names = { ...remote, refs: async () => ({ tags: [], heads: ['main'] }) };
    const unknown = await outdatedEntries(ctx, { scope: 'project', remote: names });
    expect(unknown.items.find((i) => i.name === 'branch')).toMatchObject({
      wanted: 'main (head)',
      status: 'unknown',
    });
    expect(unknown.warnings.some((w) => w.includes('branch-tracking'))).toBe(true);
  });

  it('a newer tag on the locked commit is no update (the commit is compared, not the name)', async () => {
    const tagged = {
      refs: async () => ({
        tags: ['v1.0.0', 'v1.0.1'],
        heads: [],
        tagShas: { 'v1.0.0': shas['v1.0.0']!, 'v1.0.1': shas['v1.0.0']! },
      }),
      latest: async () => 'v1.0.1',
    };
    const r = await outdatedEntries(ctx, { scope: 'project', remote: tagged });
    const rows = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(rows.ranged).toMatchObject({ wanted: `v1.0.1 (${shas['v1.0.0']!.slice(0, 7)})` });
    expect(rows.ranged?.status).toBe('current'); // ^1.0 → v1.0.1, the commit already locked
    expect(rows.exact?.status).toBe('current'); // pinned v1.0.0 = the latest release's commit
  });

  it('an unreachable remote or --offline: unknown rows and a warning, never an error', async () => {
    const broken = { refs: async () => Promise.reject(new Error('unreachable')) };
    const r = await outdatedEntries(ctx, { scope: 'project', kind: 'skill', remote: broken });
    expect(r.items.find((i) => i.name === 'ranged')).toMatchObject({
      status: 'unknown',
      latest: '?',
    });
    expect(r.warnings.some((w) => w.includes('unreachable'))).toBe(true);
    ctx.flags.offline = true;
    const off = await outdatedEntries(ctx, { scope: 'project' });
    expect(off.items.every((i) => i.status === 'unknown' || i.status === 'untracked')).toBe(true);
    expect(off.warnings[0]).toBe('offline: remote refs were not checked');
  });

  it('CLI: the table, --json, exit 0 always; a bad kind is a usage error', async () => {
    const at = { cwd: sb.project, env: sb.env };
    await writeFiles(sb.palmHome, {
      'config.yaml': `origins:\n  - { alias: r, type: git, url: ${url} }\n`,
    });
    const text = await runInProcess(['outdated'], at);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/kind\s+name\s+origin\s+current\s+wanted\s+latest/);
    expect(text.stdout).toMatch(
      /skill\s+ranged\s+r\s+v1\.0\.0 \(\w{7}\)\s+v1\.1\.0 \(\w{7}\)\s+v1\.1\.0 \(\w{7}\)/,
    );
    expect(text.stdout).toContain('at an older commit than palm.yaml wants');
    const json = await runInProcess(['outdated', 'skills', '--json'], at);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout);
    expect(doc.items.find((i: { name: string }) => i.name === 'exact').status).toBe('pinned');
    const bad = await runInProcess(['outdated', 'widgets'], at);
    expect(bad.code).toBe(2);
    const empty = await runInProcess(['outdated', '-g'], at);
    expect(empty).toMatchObject({ code: 0 });
    expect(empty.stdout).toContain('Nothing installed in the global scope.');
  });
});

describe('outdated helpers', () => {
  it('labels refs', () => {
    expect(refLabel({ ref: 'v1.2.0', sha: 'abcdef0123' })).toBe('v1.2.0 (abcdef0)');
    expect(refLabel({ sha: 'abcdef0123' })).toBe('abcdef0');
    expect(refLabel({})).toBe('?');
  });
});
