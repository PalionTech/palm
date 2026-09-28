import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWithContext, parseInstallArgs } from '../../src/commands/install.js';
import type { PalmContext } from '../../src/core/types.js';
import { type FakeUI, fakeUI, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Sandbox project with a `.git` but no harness markers, one local origin, and a UI that refuses the target picker. */
async function world(
  chooseMany?: () => unknown[],
): Promise<{ sb: Sandbox; ctx: PalmContext; ui: FakeUI }> {
  const sb = await sandbox();
  const ui = fakeUI({
    chooseMany:
      chooseMany ??
      (() => {
        throw new Error('the target picker must not be shown');
      }),
  });
  const ctx = await makeContext(sb, { ui, flags: { offline: true } });
  ctx.config.origins.push({
    alias: 'matt',
    type: 'local',
    path: join(FIXTURES, 'mattpocock-like'),
  });
  return { sb, ctx, ui };
}

describe('palm install: names resolve before targets are asked for', () => {
  let sb: Sandbox | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (sb) await removeDir(sb.root);
    sb = undefined;
  });

  it('install skill nonexistent (no harness markers) → E_NOT_FOUND, target picker never shown', async () => {
    const w = await world();
    sb = w.sb;
    const err = await installWithContext(
      w.ctx,
      parseInstallArgs(['install', 'skill', 'nonexistent']),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'E_NOT_FOUND',
      message: 'No skill named "nonexistent" in any origin',
    });
    expect(w.ui.pickManys).toHaveLength(0);
    expect(existsSync(join(sb.project, 'palm.yaml'))).toBe(false);
  });

  it('keeps the engine fuzzy suggestions in the pre-flight error', async () => {
    const w = await world();
    sb = w.sb;
    const err = await installWithContext(
      w.ctx,
      parseInstallArgs(['install', 'skill', 'grill-mee']),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_NOT_FOUND' });
    expect((err as { hint?: string }).hint).toContain('Did you mean: grill-me@matt?');
    expect(w.ui.pickManys).toHaveLength(0);
  });

  it('a kind-less name that matches nothing but is a local directory → E_USAGE origin hint', async () => {
    const w = await world();
    sb = w.sb;
    await mkdir(join(sb.project, 'vendored-skills'));
    const err = await installWithContext(
      w.ctx,
      parseInstallArgs(['install', 'vendored-skills']),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'E_USAGE',
      message: '"vendored-skills" is a repository, not an entity name',
    });
    expect((err as { hint?: string }).hint).toContain('palm origin add vendored-skills');
    expect(w.ui.pickManys).toHaveLength(0);
  });

  it('a name that resolves goes on to the target picker, then installs', async () => {
    const w = await world(() => ['claude']);
    sb = w.sb;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await installWithContext(w.ctx, parseInstallArgs(['install', 'skill', 'grill-me']));
    expect(w.ui.pickManys).toHaveLength(1);
    expect(existsSync(join(sb.project, '.claude', 'skills', 'grill-me', 'SKILL.md'))).toBe(true);
  });
});
