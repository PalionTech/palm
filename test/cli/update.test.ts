import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, UI } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { installEntities } from '../../src/engine/install.js';
import { makeWorld, type World } from '../engine/world.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

/** A UI whose y/N answer is fixed and whose confirm calls are recorded. */
function confirmUI(answer: boolean, interactive = true) {
  const calls: Array<{ message: string; initial?: boolean }> = [];
  const ui: UI = {
    ...fakeUI({ interactive }),
    confirm: async (message, initial) => {
      calls.push({ message, initial });
      return answer;
    },
  };
  return { ui, calls };
}

describe('palm update (CLI): plan, confirm, apply', () => {
  let w: World;
  const hash = async () =>
    (await Lock.load(join(w.sb.project, 'palm.lock.yaml'))).find({
      kind: 'skill',
      name: 'wayfinder',
    })?.contentHash;
  const update = (args: string[], ui: UI) =>
    runInProcess(['update', ...args], { cwd: w.sb.project, env: w.sb.env, deps: w.deps, ui });

  beforeEach(async () => {
    w = await makeWorld();
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${w.origins.a} }\n`,
    );
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'wayfinder' },
        { kind: 'skill', spec: 'tdd' },
      ],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    await writeFile(join(w.origins.a, 'skills/wayfinder/SKILL.md'), 'wayfinder v2\n');
  });
  afterEach(async () => removeDir(w.sb.root));

  it('--dry-run prints the plan and writes nothing', async () => {
    const before = await hash();
    const { ui, calls } = confirmUI(true);
    const r = await update(['--dry-run'], ui);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Update plan (project scope)');
    expect(r.stdout).toMatch(/~ updated\s+skill\s+wayfinder\s+a\s+content \w{7} → content \w{7}/);
    expect(r.stdout).toMatch(/= unchanged\s+skill\s+tdd/);
    expect(r.stdout).toContain('dry run: nothing written');
    expect(calls).toEqual([]);
    expect(await hash()).toBe(before);

    const json = await update(['--dry-run', '--json'], ui);
    const doc = JSON.parse(json.stdout);
    expect(doc.plan.map((i: { name: string; mark: string }) => [i.name, i.mark])).toEqual([
      ['tdd', 'unchanged'],
      ['wayfinder', 'updated'],
    ]);
    expect(doc.outcomes).toEqual([]);
  });

  it('without a terminal and without --yes: E_NON_INTERACTIVE after the plan, nothing written', async () => {
    const before = await hash();
    const { ui } = confirmUI(true, false);
    const r = await update([], ui);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('~ updated');
    expect(r.stderr).toContain('x palm update changes installed files and needs a confirmation');
    expect(r.stderr).toContain('palm update --yes');
    expect(await hash()).toBe(before);

    const yes = await update(['--yes'], ui);
    expect(yes.code).toBe(0);
    expect(await hash()).not.toBe(before);
  });

  it('asks once, default No; No changes nothing, yes applies', async () => {
    const before = await hash();
    const no = confirmUI(false);
    const declined = await update(['skill', 'wayfinder'], no.ui);
    expect(declined.code).toBe(0);
    expect(no.calls).toEqual([{ message: 'Apply 1 change?', initial: false }]);
    expect(declined.stdout).toContain('Nothing changed.');
    expect(await hash()).toBe(before);

    const yes = confirmUI(true);
    const applied = await update(['skills'], yes.ui);
    expect(applied.code).toBe(0);
    expect(yes.calls).toHaveLength(1);
    expect(applied.stdout).toMatch(/~ updated\s+skill\s+wayfinder/);
    expect(await hash()).not.toBe(before);

    const again = confirmUI(true);
    const nothing = await update([], again.ui);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain('Nothing to update.');
    expect(again.calls).toEqual([]);
  });

  it('lists the commands the update would allow to run; its one prompt covers them', async () => {
    const scan = w.deps.scan!;
    const hook: Entity = {
      kind: 'hook',
      name: 'fmt',
      path: 'skills/tdd',
      origin: 'a',
      def: {
        kind: 'hook',
        hooks: {
          name: 'fmt',
          dialect: 'claude',
          raw: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: './fmt.sh' }] }] } },
        },
      },
    };
    w.deps.scan = async (root, spec) => {
      const r = await scan(root, spec);
      return { ...r, entities: [...r.entities, hook] };
    };
    w.ctx.flags.yes = true;
    const project = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(w.ctx, [{ kind: 'hook', spec: 'fmt' }], project, w.deps);
    await writeFile(join(w.origins.a, 'skills/tdd/SKILL.md'), 'tdd v2\n');

    const { ui, calls } = confirmUI(true);
    const r = await update(['hook', 'fmt'], ui);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('! this update writes a command that runs on your machine:');
    expect(r.stdout).toContain('    hook fmt (claude): PostToolUse → ./fmt.sh');
    expect(calls).toEqual([
      { message: 'Apply 1 change and allow that command to run?', initial: false },
    ]);
    expect(r.stdout).toMatch(/~ updated\s+hook\s+fmt/);
  });

  it('an unreachable origin exits 1 even with nothing else to do', async () => {
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${join(w.sb.root, 'gone')} }\n`,
    );
    const { ui, calls } = confirmUI(true);
    const r = await update([], ui);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/x failed\s+skill\s+tdd\s+a\s+.*unreachable origin "a"/);
    expect(r.stderr).toContain('x skill tdd@a: unreachable origin "a": ');
    expect(calls).toEqual([]);
  });
});
