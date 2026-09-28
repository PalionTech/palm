import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineDeps, PalmContext } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { installEntities } from '../../src/engine/install.js';
import { applyUpdate, planChanges, planUpdate } from '../../src/engine/update.js';
import { commitFile, git } from '../core/gitrepo.js';
import { fakeTargets, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

const SKILL = (body: string) => `---\nname: tdd\ndescription: test first\n---\n${body}\n`;

/** A skill repository with tag v1.0.0, cloned bare as the origin's remote. */
async function skillRepo(root: string): Promise<{ work: string; bare: string; sha: string }> {
  const work = join(root, 'work');
  const bare = join(root, 'remote.git');
  await execa('git', ['init', '-q', '-b', 'main', work]);
  await mkdir(join(work, 'skills/tdd'), { recursive: true });
  const sha = await commitFile(work, 'skills/tdd/SKILL.md', SKILL('v1'), 'one');
  await git(work, 'tag', 'v1.0.0');
  await execa('git', ['clone', '-q', '--bare', work, bare]);
  return { work, bare, sha };
}

/** A new release on the remote: the skill changed, tagged and pushed. */
async function release(repo: { work: string; bare: string }, tag: string): Promise<string> {
  const sha = await commitFile(repo.work, 'skills/tdd/SKILL.md', SKILL(tag), tag);
  await git(repo.work, 'tag', tag);
  await git(repo.work, 'push', '-q', repo.bare, 'main', tag);
  return sha;
}

describe('palm update: plan, then apply', () => {
  let sb: Sandbox;
  let ctx: PalmContext;
  let deps: Partial<EngineDeps>;
  let repo: { work: string; bare: string; sha: string };
  const project = { scope: 'project' as const };
  const lockFile = () => join(sb.project, 'palm.lock.yaml');

  beforeEach(async () => {
    sb = await sandbox();
    repo = await skillRepo(sb.root);
    ctx = await makeContext(sb);
    ctx.config.origins.push({ alias: 'r', type: 'git', url: repo.bare });
    deps = { getTarget: fakeTargets().getTarget };
    const r = await installEntities(
      ctx,
      [{ kind: 'skill', spec: 'tdd@r' }],
      { scope: 'project', targets: ['claude'] },
      deps,
    );
    expect(r.outcomes.map((o) => o.status)).toEqual(['installed']);
  });
  afterEach(async () => removeDir(sb.root));

  it('an unchanged origin: = unchanged, nothing to apply', async () => {
    const plan = await planUpdate(ctx, [], project, deps);
    expect(plan.items).toEqual([
      {
        mark: 'unchanged',
        kind: 'skill',
        name: 'tdd',
        origin: 'r',
        from: `v1.0.0 (${repo.sha.slice(0, 7)})`,
        atRisk: [],
      },
    ]);
    expect(planChanges(plan)).toBe(0);
    expect(plan.apply).toEqual([]);
  });

  it('a new release: ~ updated old → new; the plan writes nothing, apply reinstalls', async () => {
    const before = (await Lock.load(lockFile())).find({ kind: 'skill', name: 'tdd' });
    const sha = await release(repo, 'v1.1.0');
    const plan = await planUpdate(ctx, [{ kind: 'skill', name: 'tdd' }], project, deps);
    expect(plan.items).toMatchObject([
      {
        mark: 'updated',
        name: 'tdd',
        from: `v1.0.0 (${repo.sha.slice(0, 7)})`,
        to: `v1.1.0 (${sha.slice(0, 7)})`,
        atRisk: [],
      },
    ]);
    expect(planChanges(plan)).toBe(1);
    expect((await Lock.load(lockFile())).find({ kind: 'skill', name: 'tdd' })).toEqual(before);

    const result = await applyUpdate(ctx, plan, deps);
    expect(result.outcomes.map((o) => [o.entry.name, o.status])).toEqual([['tdd', 'updated']]);
    expect(result.failures).toEqual([]);
    const after = (await Lock.load(lockFile())).find({ kind: 'skill', name: 'tdd' });
    expect(after).toMatchObject({ ref: 'v1.1.0', sha });
  });

  it('lists the files the user changed that the update would overwrite', async () => {
    await release(repo, 'v1.1.0');
    await writeFile(join(sb.project, '.claude/skill/tdd.txt'), 'my own notes\n');
    const plan = await planUpdate(ctx, [], project, deps);
    expect(plan.items[0]).toMatchObject({ mark: 'updated', atRisk: ['.claude/skill/tdd.txt'] });
  });

  it('an unreachable origin: x failed, recorded as a failure; nothing applied', async () => {
    await rm(repo.bare, { recursive: true, force: true });
    const plan = await planUpdate(ctx, [], project, deps);
    expect(plan.items).toMatchObject([{ mark: 'failed', name: 'tdd' }]);
    expect(plan.items[0]!.note).toContain('unreachable origin "r"');
    expect(plan.failures).toMatchObject([{ kind: 'skill', name: 'tdd', origin: 'r' }]);
    const result = await applyUpdate(ctx, plan, deps);
    expect(result.failures).toHaveLength(1);
    expect(result.outcomes).toEqual([]);
  });
});
