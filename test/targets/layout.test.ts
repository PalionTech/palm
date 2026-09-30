/** Where each harness writes: detection, config dirs, output dirs, shared skills and overrides. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetId } from '../../src/core/types.js';
import { allTargets, createTarget, getTarget } from '../../src/targets/index.js';
import {
  allKinds,
  cleanupTmp,
  fakeEnv,
  install,
  makeSource,
  renderInput,
  tmpDir,
  write,
} from './helpers.js';

vi.mock('../../src/lib/fs.js', async (orig) => (await import('./fakes.js')).withFs(await orig()));
vi.mock('../../src/domain/scope-paths.js', async (orig) =>
  (await import('./fakes.js')).withScopePaths(await orig()),
);
vi.mock('../../src/domain/lock.js', async (orig) =>
  (await import('./fakes.js')).withLock(await orig()),
);
vi.mock('../../src/domain/merged-record.js', async (orig) =>
  (await import('./fakes.js')).withMergedRecord(await orig()),
);
vi.mock('../../src/domain/ignore.js', async (orig) =>
  (await import('./fakes.js')).withIgnore(await orig()),
);
vi.mock('../../src/core/hash.js', async (orig) =>
  (await import('./fakes.js')).withHash(await orig()),
);

afterEach(cleanupTmp);

describe('skills directory by active targets', () => {
  it('cursor writes .claude/skills when claude is active, else .agents/skills; global: <agents>/skills', async () => {
    const root = await tmpDir();
    const src = await makeSource();
    const k = allKinds(src).find((e) => e.label === 'skill')!;
    const cursor = createTarget('cursor', fakeEnv(root));
    const at = (targets: TargetId[], scope: 'project' | 'global' = 'project') =>
      cursor.render(renderInput({ ...k, scope, scopeRoot: root, sourceRoot: src.root, targets }));
    const withClaude = await at(['claude', 'cursor']);
    expect(withClaude.files[0]?.path).toBe('.claude/skills/demo/SKILL.md');
    expect(withClaude.notes).toEqual(['cursor reads .claude/skills; no second copy']);
    // the same bytes as claude's own render: one copy on disk
    const claude = await createTarget('claude', fakeEnv(root)).render(
      renderInput({ ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root }),
    );
    expect(withClaude.hash).toBe(claude.hash);
    expect((await at(['cursor', 'codex'])).files[0]?.path).toBe('.agents/skills/demo/SKILL.md');
    // claude plus codex: two copies, noted
    const codex = await createTarget('codex', fakeEnv(root)).render(
      renderInput({
        ...k,
        scope: 'project',
        scopeRoot: root,
        sourceRoot: src.root,
        targets: ['claude', 'codex'],
      }),
    );
    expect(codex.notes).toEqual([
      'codex does not read .claude/skills; claude gets a second copy there',
    ]);
    expect((await at(['claude', 'cursor'], 'global')).files[0]?.path).toBe(
      '<agents>/skills/demo/SKILL.md',
    );
  });
});

describe('outputDirs (lock form, for overlap checks)', () => {
  it('per harness and scope', () => {
    const env = { HOME: '/h' };
    const dirs = (id: TargetId, scope: 'project' | 'global', root: string) =>
      getTarget(id).outputDirs(scope, root, env);
    expect(dirs('claude', 'project', '/p')).toEqual(['.claude']);
    expect(dirs('codex', 'project', '/p')).toEqual(['.agents/skills', '.codex']);
    expect(dirs('copilot', 'project', '/p')).toEqual([
      '.agents/skills',
      '.github/agents',
      '.github/hooks',
      '.github/instructions',
    ]);
    expect(dirs('cursor', 'project', '/p')).toEqual([
      '.agents/skills',
      '.claude/skills',
      '.cursor',
    ]);
    expect(dirs('gemini', 'project', '/p')).toEqual(['.agents/skills', '.gemini']);
    expect(dirs('opencode', 'project', '/p')).toEqual(['.agents/skills', '.opencode']);
    expect(dirs('claude', 'global', '/h')).toEqual(['<claude>']);
    expect(dirs('cursor', 'global', '/h')).toEqual(['<agents>/skills', '<cursor>']);
  });
});

describe('environment overrides (global scope)', () => {
  it('honours CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and PALM_HOME; the lock names tokens', async () => {
    const src = await makeSource();
    const home = await tmpDir();
    const env = fakeEnv(home, {
      CLAUDE_CONFIG_DIR: path.join(home, 'alt-claude'),
      CODEX_HOME: '~/alt-codex',
      COPILOT_HOME: path.join(home, 'alt-copilot'),
      PALM_HOME: path.join(home, 'alt-palm'),
    });
    const kinds = Object.fromEntries(allKinds(src).map((k) => [k.label, k]));
    const put = (id: TargetId, label: string) =>
      install(createTarget(id, env), {
        ...kinds[label]!,
        scope: 'global',
        scopeRoot: home,
        sourceRoot: src.root,
      });
    expect((await put('claude', 'agent')).result.files).toEqual(['<claude>/agents/demo.md']);
    await fs.access(path.join(home, 'alt-claude/agents/demo.md'));
    expect((await put('claude', 'mcp stdio')).result.merged?.[0]?.file).toBe(
      '<claude>/.claude.json',
    );
    await fs.access(path.join(home, 'alt-claude/.claude.json'));
    expect((await put('codex', 'agent')).result.files).toEqual(['<codex>/agents/demo.toml']);
    await fs.access(path.join(home, 'alt-codex/agents/demo.toml'));
    expect((await put('codex', 'instruction')).result.merged?.[0]?.file).toBe('<codex>/AGENTS.md');
    expect((await put('copilot', 'agent')).result.files).toEqual([
      '<copilot>/agents/demo.agent.md',
    ]);
    const hook = await put('cursor', 'hook');
    expect(hook.result.files).toContain('<palm>/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh');
    await fs.access(path.join(home, 'alt-palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh'));
    // PALM_HOME is set: the command reads it at run time, with the default as a fallback
    expect(hook.rendered.exec[0]?.command).toContain(
      '"${PALM_HOME:-$HOME/.palm}"/assets/acme__kit/fmt',
    );
    await createTarget('cursor', env).undeploy(hook.entry, 'global', home, false);
    await expect(fs.access(path.join(home, 'alt-palm/assets/acme__kit'))).rejects.toThrow();
    // skills stay under ~/.agents regardless of CODEX_HOME
    expect((await put('codex', 'skill')).result.files[0]).toBe('<agents>/skills/demo/SKILL.md');
  });

  it('the call env wins over the env bound by createTarget, which wins over process.env', async () => {
    const home = await tmpDir();
    const bound = await tmpDir();
    const elsewhere = await tmpDir();
    vi.stubEnv('CLAUDE_CONFIG_DIR', elsewhere);
    try {
      const at = (env?: NodeJS.ProcessEnv) =>
        createTarget('claude', fakeEnv(home, { CLAUDE_CONFIG_DIR: bound })).configDir(
          'global',
          home,
          env ?? {},
        );
      expect(at(fakeEnv(home))).toBe(path.join(home, '.claude'));
      expect(getTarget('claude').configDir('global', home, process.env)).toBe(elsewhere);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('detect / configDir / registry', () => {
  it('detects harness markers per scope', async () => {
    const root = await tmpDir();
    const env = fakeEnv(root);
    for (const t of allTargets()) {
      expect(await t.detect('project', root, env)).toBe(false);
      expect(await t.detect('global', root, env)).toBe(false);
    }
    await write(path.join(root, 'CLAUDE.md'), '');
    await write(path.join(root, 'AGENTS.md'), '');
    await write(path.join(root, '.vscode/mcp.json'), '{}');
    await fs.mkdir(path.join(root, '.cursor'));
    await write(path.join(root, 'GEMINI.md'), '');
    await write(path.join(root, 'opencode.json'), '{}');
    for (const t of allTargets()) expect(await t.detect('project', root, env)).toBe(true);
    await fs.mkdir(path.join(root, '.copilot'));
    expect(await getTarget('copilot').detect('global', root, env)).toBe(true);
    expect(await getTarget('cursor').detect('global', root, env)).toBe(true);
    const other = await tmpDir();
    await fs.mkdir(path.join(other, '.gemini'));
    await write(path.join(other, 'opencode.jsonc'), '{}');
    expect(await getTarget('gemini').detect('project', other, env)).toBe(true);
    expect(await getTarget('opencode').detect('project', other, env)).toBe(true);
    expect(await getTarget('gemini').detect('global', root, env)).toBe(false);
    await fs.mkdir(path.join(root, '.config/opencode'), { recursive: true });
    expect(await getTarget('opencode').detect('global', root, env)).toBe(true);
    expect(
      await getTarget('gemini').detect('global', root, { ...env, GEMINI_CLI_HOME: other }),
    ).toBe(true);
    await fs.mkdir(path.join(root, 'cc'));
    expect(
      await getTarget('codex').detect('global', root, {
        ...env,
        CODEX_HOME: path.join(root, 'cc'),
      }),
    ).toBe(true);
    expect(await getTarget('codex').detect('global', root, env)).toBe(false);
  });

  it('configDir', () => {
    const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/cc', CODEX_HOME: '/cx' };
    expect(getTarget('claude').configDir('project', '/p', env)).toBe('/p/.claude');
    expect(getTarget('claude').configDir('global', '/h', env)).toBe('/cc');
    expect(getTarget('claude').configDir('global', '/h', { HOME: '/h' })).toBe('/h/.claude');
    expect(getTarget('codex').configDir('global', '/h', env)).toBe('/cx');
    expect(getTarget('copilot').configDir('project', '/p', env)).toBe('/p/.github');
    expect(getTarget('copilot').configDir('global', '/h', env)).toBe('/h/.copilot');
    expect(getTarget('cursor').configDir('global', '/h', env)).toBe('/h/.cursor');
    expect(getTarget('gemini').configDir('global', '/h', { GEMINI_CLI_HOME: '/g' })).toBe(
      '/g/.gemini',
    );
    expect(getTarget('opencode').configDir('global', '/h', env)).toBe('/h/.config/opencode');
    expect(getTarget('opencode').configDir('global', '/h', { XDG_CONFIG_HOME: '/x' })).toBe(
      '/x/opencode',
    );
    expect(getTarget('opencode').configDir('project', '/p', { XDG_CONFIG_HOME: '/x' })).toBe(
      '/p/.opencode',
    );
  });

  it('getTarget / allTargets', () => {
    expect(allTargets().map((t) => [t.id, t.displayName])).toEqual([
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
      ['copilot', 'GitHub Copilot'],
      ['cursor', 'Cursor'],
      ['gemini', 'Gemini CLI'],
      ['opencode', 'OpenCode'],
    ]);
    expect(() => getTarget('vim' as TargetId)).toThrowError(/unknown target/);
  });
});
