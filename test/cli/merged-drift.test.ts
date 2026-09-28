/**
 * Merged fragments (an `.mcp.json` key, a hook entry in `.claude/settings.json`) are checked
 * like files (H3): `palm doctor` reports them missing or changed, `palm install --frozen` lists
 * them as differences, and a bare `palm install` merges them back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Check } from '../../src/commands/doctor.js';
import type { Entity } from '../../src/core/types.js';
import { makeWorld, type World } from '../engine/world.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

const HOOK: Entity = {
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

describe('merged fragments: doctor, --frozen and bare install (H3)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  const palm = (args: string[]) =>
    runInProcess(args, {
      cwd: w.sb.project,
      env: { ...w.sb.env, PATH: process.env.PATH },
      deps: w.deps,
      ui: fakeUI(),
    });
  const at = (p: string) => join(w.sb.project, p);
  const json = async (p: string) => JSON.parse(await readFile(at(p), 'utf8'));
  const lockCheck = async (): Promise<Check> => {
    const r = await palm(['doctor', '--offline', '--json']);
    const checks = (JSON.parse(r.stdout) as { items: Check[] }).items;
    return checks.find((c) => c.group === 'lock' && c.name === 'project scope')!;
  };

  async function installed(): Promise<void> {
    w = await makeWorld();
    w.deps.getTarget = (await import('../../src/targets/index.js')).getTarget;
    const scan = w.deps.scan!;
    w.deps.scan = async (root, spec) => {
      const r = await scan(root, spec);
      return { ...r, entities: [...r.entities, { ...HOOK, origin: spec.alias }] };
    };
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${w.origins.a} }\n`,
    );
    expect((await palm(['install', 'hook', 'fmt@a', '--target', 'claude', '-y'])).code).toBe(0);
    const mcp = ['install', 'mcp', 'docs', '--url', 'https://docs.example/mcp', '-y'];
    expect((await palm(mcp)).code).toBe(0);
    expect((await json('.mcp.json')).mcpServers.docs.url).toBe('https://docs.example/mcp');
    expect((await json('.claude/settings.json')).hooks.PostToolUse).toHaveLength(1);
    expect(await lockCheck()).toMatchObject({ status: 'ok' });
  }

  it('a deleted .mcp.json key and hook entry: doctor drift, --frozen fails, bare install restores', async () => {
    await installed();
    await writeFile(at('.mcp.json'), '{ "mcpServers": {} }\n');
    await writeFile(at('.claude/settings.json'), '{ "hooks": {} }\n');

    const drift = await lockCheck();
    expect(drift.status).toBe('warn');
    expect(drift.detail).toContain('.mcp.json#/mcpServers/docs missing (palm merged it)');
    expect(drift.detail).toContain(
      '.claude/settings.json#/hooks/PostToolUse missing (palm merged it)',
    );

    const frozen = await palm(['install', '--frozen']);
    expect(frozen.code).toBe(1);
    expect(frozen.stderr).toContain(
      '.mcp.json#/mcpServers/docs (mcp docs): missing (palm merged it)',
    );
    expect(frozen.stderr).toContain(
      '.claude/settings.json#/hooks/PostToolUse (hook fmt): missing (palm merged it)',
    );

    const sync = await palm(['install']);
    expect(sync.code).toBe(0);
    expect((await json('.mcp.json')).mcpServers.docs.url).toBe('https://docs.example/mcp');
    expect((await json('.claude/settings.json')).hooks.PostToolUse).toHaveLength(1);
    expect(await lockCheck()).toMatchObject({ status: 'ok' });
    expect((await palm(['install', '--frozen'])).code).toBe(0);
  });

  it('a changed key is drift too; a deleted file is restored', async () => {
    await installed();
    const cfg = await json('.mcp.json');
    cfg.mcpServers.docs.url = 'https://evil.example/mcp';
    await writeFile(at('.mcp.json'), JSON.stringify(cfg));
    expect((await lockCheck()).detail).toContain(
      '.mcp.json#/mcpServers/docs changed since palm merged it',
    );
    expect((await palm(['install', '--frozen'])).code).toBe(1);
    expect((await palm(['install'])).code).toBe(0);
    expect((await json('.mcp.json')).mcpServers.docs.url).toBe('https://docs.example/mcp');

    const { rm } = await import('node:fs/promises');
    await rm(at('.claude/settings.json'));
    expect((await palm(['install'])).code).toBe(0);
    expect((await json('.claude/settings.json')).hooks.PostToolUse).toHaveLength(1);
  });
});
