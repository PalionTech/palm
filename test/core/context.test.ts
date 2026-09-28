import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addOrigin, ensureMineOrigin, removeOrigin } from '../../src/core/config.js';
import { refreshOrigins } from '../../src/core/context.js';
import type { OriginSpec, PalmContext } from '../../src/core/types.js';
import { OriginSet } from '../../src/domain/origin-set.js';
import { fakeLogger, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

const sp: OriginSpec = { alias: 'sp', type: 'git', url: 'https://github.com/obra/superpowers.git' };
const fork: OriginSpec = { alias: 'fork', type: 'git', url: 'https://github.com/acme/fork.git' };

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => removeDir(sb.root));

const writeProject = (yaml: string): Promise<void> =>
  writeFile(join(sb.project, 'palm.yaml'), yaml);

describe('ctx.origins', () => {
  it('is loaded on first use, so a bad palm.yaml alias does not break context creation', async () => {
    await writeProject('origins:\n  - { url: https://github.com/acme/tools.git }\n');
    const ctx = await makeContext(sb);
    expect(ctx.config).toEqual({ origins: [] });
    expect(() => ctx.origins).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
    // failures are not cached: fixing the file fixes the context
    await writeProject('origins:\n  - { alias: tools, url: https://github.com/acme/tools.git }\n');
    expect(ctx.origins.aliases()).toEqual(['tools']);
  });

  it('reads palm.yaml once per context and warns once', async () => {
    await writeProject(
      'origins:\n  - { alias: evil, url: "--x" }\n  - { alias: fork, url: https://github.com/acme/fork.git }\n',
    );
    const log = fakeLogger();
    const ctx = await makeContext(sb, { log });
    const first = ctx.origins;
    expect(first.aliases()).toEqual(['fork']);
    await writeProject('origins: []\n');
    for (let i = 0; i < 5; i++) ctx.origins.specs();
    expect(ctx.origins).toBe(first);
    expect(log.messages.filter((m) => m.level === 'warn')).toHaveLength(1);
  });

  it('follows ctx.config.origins changed in place (tests and older callers push to it)', async () => {
    await writeProject('origins:\n  - { alias: fork, url: https://github.com/acme/fork.git }\n');
    const ctx = await makeContext(sb);
    const before = ctx.origins;
    ctx.config.origins.push(sp);
    expect(ctx.origins).not.toBe(before);
    expect(ctx.origins.aliases()).toEqual(['sp', 'fork']);
    expect(ctx.origins.byAlias('SP')?.spec).toBe(sp);
    expect(ctx.origins.projectSpecs()).toEqual([fork]);
  });

  it('refreshes after addOrigin, removeOrigin and ensureMineOrigin without mutating ctx.config', async () => {
    const ctx = await makeContext(sb);
    const config0 = ctx.config;
    const origins0 = config0.origins;
    await addOrigin(ctx, sp);
    expect(ctx.config).not.toBe(config0);
    expect(origins0).toEqual([]); // the old config object was not touched
    expect(ctx.origins.aliases()).toEqual(['sp']);

    await addOrigin(ctx, fork, { scope: 'project' });
    expect(ctx.origins.aliases()).toEqual(['sp', 'fork']);
    expect(ctx.origins.projectSpecs()).toEqual([fork]);
    expect(await readFile(join(sb.project, 'palm.yaml'), 'utf8')).toContain('alias: fork');

    // a same-id replacement in the project layer overrides the user origin
    await addOrigin(ctx, { ...sp, ref: 'v2' }, { scope: 'project' });
    expect(ctx.origins.byAlias('sp')?.spec?.ref).toBe('v2');

    const config1 = ctx.config;
    await removeOrigin(ctx, 'sp');
    expect(ctx.config).not.toBe(config1);
    expect(config1.origins.map((o) => o.alias)).toEqual(['sp']);
    expect(ctx.origins.aliases()).toEqual(['fork']);
    await removeOrigin(ctx, 'fork');
    expect(ctx.origins.size).toBe(0);

    const mine = await ensureMineOrigin(ctx);
    expect(ctx.origins.byAlias('mine')?.spec).toBe(mine);
  });

  it('removeOrigin works on config.yaml even when palm.yaml has an alias problem', async () => {
    const ctx = await makeContext(sb);
    await addOrigin(ctx, sp);
    await writeProject('origins:\n  - { url: https://github.com/acme/tools.git }\n');
    const fresh = await makeContext(sb);
    await removeOrigin(fresh, 'sp');
    expect(fresh.config.origins).toEqual([]);
    await expect(removeOrigin(fresh, 'sp')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('can be assigned: the assigned set becomes the project layer, config stays the user layer', async () => {
    const ctx = await makeContext(sb);
    ctx.config.origins.push(sp);
    ctx.origins = OriginSet.of([{ ...sp, ref: 'ignored' }]).withProject([fork]);
    expect(ctx.origins.userSpecs()).toEqual([sp]);
    expect(ctx.origins.projectSpecs()).toEqual([fork]);
  });

  it('survives a spread copy (engine preflight) as a plain value', async () => {
    const ctx = await makeContext(sb);
    ctx.config.origins.push(sp);
    const copy: PalmContext = { ...ctx, log: fakeLogger() };
    expect(copy.origins.aliases()).toEqual(['sp']);
  });
});

describe('refreshOrigins on a hand-built context', () => {
  const handBuilt = (): PalmContext => ({
    paths: { palmHome: '/p', home: '/h', projectRoot: '/r', cwd: '/r' },
    config: { origins: [] },
    origins: OriginSet.of().withProject([fork]),
    ui: {} as PalmContext['ui'],
    log: fakeLogger(),
    env: {},
    flags: { yes: false, dryRun: false, force: false, offline: false, verbose: false },
  });

  it('rebuilds the plain origins value from the new config and project layer', () => {
    const ctx = handBuilt();
    refreshOrigins(ctx, { config: { origins: [sp] } });
    expect(ctx.origins.aliases()).toEqual(['sp', 'fork']);
    refreshOrigins(ctx, { project: [] });
    expect(ctx.origins.aliases()).toEqual(['sp']);
    refreshOrigins(ctx, { project: 'reload' });
    expect(ctx.origins.aliases()).toEqual(['sp']);
  });

  it('copes with a context that has no origins value at all', () => {
    const ctx = { ...handBuilt(), origins: undefined } as unknown as PalmContext;
    refreshOrigins(ctx, {});
    expect(ctx.origins.size).toBe(0);
  });
});
