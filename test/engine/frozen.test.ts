import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { getIndex } from '../../src/core/cache.js';
import { loadLock } from '../../src/core/lockfile.js';
import { loadManifest, saveManifest } from '../../src/core/manifest.js';
import type { OriginSpec, PalmContext } from '../../src/core/types.js';
import { installEntities } from '../../src/engine/install.js';
import { syncManifest } from '../../src/engine/sync.js';
import { git } from '../core/gitrepo.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, writeFiles } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

interface Remote {
  work: string;
  bare: string;
  v1: string;
}

/** Writes `files` in the work tree and commits them; returns the new HEAD. */
async function commit(work: string, files: Record<string, string>, message: string) {
  await writeFiles(work, files);
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

/** A git origin with skills foo and bar at tag v1.0.0, pushed to a bare "remote". */
async function makeRemote(root: string): Promise<Remote> {
  const work = join(root, 'work');
  const bare = join(root, 'remote.git');
  await execa('git', ['init', '-q', '-b', 'main', work]);
  const v1 = await commit(
    work,
    {
      'skills/foo/SKILL.md': skillMd('foo', 'foo v1'),
      'skills/bar/SKILL.md': skillMd('bar', 'bar v1'),
    },
    'v1',
  );
  await git(work, 'tag', 'v1.0.0');
  await execa('git', ['clone', '-q', '--bare', work, bare]);
  return { work, bare, v1 };
}

/** foo v2 at tag v1.1.0 on the remote. */
async function advance(r: Remote): Promise<string> {
  const sha = await commit(r.work, { 'skills/foo/SKILL.md': skillMd('foo', 'foo v2') }, 'v2');
  await git(r.work, 'tag', 'v1.1.0');
  await git(r.work, 'push', '-q', r.bare, 'main', '--tags');
  return sha;
}

const PROJECT = { scope: 'project' as const, targets: ['claude' as const] };
const SYNC = { scope: 'project' as const, prune: false, targets: ['claude' as const] };

describe('lock replay and --frozen (git origin)', () => {
  let w: World;
  let remote: Remote;
  let spec: OriginSpec;
  afterEach(async () => removeDir(w.sb.root));

  async function world(): Promise<void> {
    w = await makeWorld({ origins: [] });
    delete w.deps.scan; // the real scanner reads the checkouts
    remote = await makeRemote(join(w.sb.root, 'git'));
    spec = { alias: 'g', type: 'git', url: remote.bare };
    w.ctx.config.origins.push(spec);
  }

  const lockFile = () => join(w.sb.project, 'palm.lock.yaml');
  const manifestFile = () => join(w.sb.project, 'palm.yaml');
  const deployedBody = async (i = -1) =>
    readFile(join(w.calls.deploy.at(i)!.input.absPath, 'SKILL.md'), 'utf8');

  it('a bare palm install deploys the locked commit, not the newer tag', async () => {
    await world();
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'foo@g' }], PROJECT, w.deps);
    const locked = (await loadLock(lockFile())).entries[0]!;
    expect(locked).toMatchObject({ sha: remote.v1, ref: 'v1.0.0', url: remote.bare });

    await advance(remote);
    await getIndex(w.ctx, spec, { refresh: true }); // the cached "latest" checkout is v1.1.0 now
    await rm(join(w.sb.project, '.claude'), { recursive: true });

    const r = await syncManifest(w.ctx, SYNC, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes[0]).toMatchObject({
      status: 'updated',
      entry: { sha: remote.v1, ref: 'v1.0.0' },
    });
    expect(await deployedBody()).toContain('foo v1');
    expect(existsSync(join(w.sb.project, '.claude/skill/foo.txt'))).toBe(true);

    // palm.yaml pinning the new tag moves it (resolved fresh, not replayed)
    await saveManifest(manifestFile(), { skills: ['foo@g#v1.1.0'] });
    const moved = await syncManifest(w.ctx, SYNC, w.deps);
    expect(moved.outcomes[0]!.entry.ref).toBe('v1.1.0');
    expect(await deployedBody()).toContain('foo v2');
  });

  it('--frozen lists every difference and writes nothing', async () => {
    await world();
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'foo@g' },
        { kind: 'skill', spec: 'bar@g' },
      ],
      PROJECT,
      w.deps,
    );
    await writeFile(join(w.sb.project, '.claude/skill/foo.txt'), 'edited');
    await saveManifest(manifestFile(), {
      targets: ['claude', 'codex'],
      skills: ['foo@g#v1.1.0', 'missing@g'],
    });
    const lockBefore = await readFile(lockFile(), 'utf8');
    const manifestBefore = await readFile(manifestFile(), 'utf8');
    const deploys = w.calls.deploy.length;

    const err = await syncManifest(
      w.ctx,
      { scope: 'project', prune: false, frozen: true, targets: ['claude', 'codex'] },
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_CONFLICT' });
    const lines = (err.message as string).split('\n').slice(1);
    expect(lines).toEqual([
      '  - skill foo@g#v1.1.0: palm.yaml pins #v1.1.0, the lock has v1.0.0',
      '  - skill missing@g: in palm.yaml, not in palm.lock.yaml',
      '  - skill bar@g: in palm.lock.yaml, not in palm.yaml',
      '  - skill bar@g: locked for claude, palm.yaml targets claude, codex',
      '  - skill foo@g: locked for claude, palm.yaml targets claude, codex',
      '  - .claude/skill/foo.txt (skill foo): changed since palm wrote it',
    ]);
    expect(err.hint).toContain('palm install without --frozen');
    expect(await readFile(lockFile(), 'utf8')).toBe(lockBefore);
    expect(await readFile(manifestFile(), 'utf8')).toBe(manifestBefore);
    expect(w.calls.deploy).toHaveLength(deploys);
  });

  it('--frozen restores missing files from the locked commit, writes no lock, needs no network once cached', async () => {
    await world();
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'foo@g' }], PROJECT, w.deps);
    await advance(remote);
    await getIndex(w.ctx, spec, { refresh: true });
    const lockBefore = await readFile(lockFile(), 'utf8');
    const frozen = { ...SYNC, frozen: true };

    await rm(join(w.sb.project, '.claude'), { recursive: true });
    const first = await syncManifest(w.ctx, frozen, w.deps); // fetches exactly the locked sha
    expect(first.failures).toEqual([]);
    expect(await deployedBody()).toContain('foo v1');
    expect(await readFile(lockFile(), 'utf8')).toBe(lockBefore);

    await rename(remote.bare, `${remote.bare}.gone`); // no remote any more
    await rm(join(w.sb.project, '.claude'), { recursive: true });
    const second = await syncManifest(w.ctx, frozen, w.deps);
    expect(second.failures).toEqual([]);
    expect(second.outcomes[0]!.status).toBe('updated');
    expect(existsSync(join(w.sb.project, '.claude/skill/foo.txt'))).toBe(true);

    // everything in place: nothing to do, still no network
    const third = await syncManifest(w.ctx, frozen, w.deps);
    expect(third.outcomes[0]!.status).toBe('unchanged');
    expect(await readFile(lockFile(), 'utf8')).toBe(lockBefore);
  });

  it('registers an alias this machine lacks from the lock URL (project), fails with the URL under -g', async () => {
    await world();
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'foo@g' }], PROJECT, w.deps);
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'foo@g' }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    );
    await rm(join(w.sb.project, '.claude'), { recursive: true });
    await rm(join(w.sb.home, '.claude'), { recursive: true });

    const fresh: PalmContext = await makeContext(w.sb, { ui: w.ui, log: w.log });
    expect(fresh.origins.byAlias('g')).toBeUndefined();
    const r = await syncManifest(fresh, SYNC, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.warnings.join('\n')).toContain(
      `origin "g" was not registered here; added ${remote.bare} to palm.yaml`,
    );
    expect((await loadManifest(manifestFile())).origins).toEqual([
      { alias: 'g', type: 'git', url: remote.bare },
    ]);
    expect(existsSync(join(w.sb.project, '.claude/skill/foo.txt'))).toBe(true);

    const other: PalmContext = await makeContext(w.sb, { ui: w.ui, log: w.log, cwd: w.sb.root });
    const g = await syncManifest(
      other,
      { scope: 'global', prune: false, targets: ['claude'] },
      w.deps,
    );
    expect(g.failures).toHaveLength(1);
    expect(g.failures[0]).toMatchObject({ name: 'foo', origin: 'g', code: 'E_ORIGIN' });
    expect(g.failures[0]!.hint).toBe(
      `register it: palm install origin ${remote.bare} --alias g -g`,
    );
  });
});
