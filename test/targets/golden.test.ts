/**
 * Golden renders: every harness's bytes for every kind, at both scopes, pinned in a snapshot
 * (files as text with their modes, fragments with id, key and value, exec lines, notes).
 *
 * Round trip: rendering and applying every kind into a scope that already uses each harness,
 * then undeploying by the lock entries, leaves every file byte-identical (content and mode) and
 * no directory behind. A render is pure: rendering again over a populated destination gives
 * the same result.
 *
 * Failed applies: a write that fails after the Applier merged a shared file (injected through
 * a failing `writeFileAtomic`) rolls everything back, so the scope is byte-identical.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scope, TargetId } from '../../src/core/types.js';
import { TARGET_IDS } from '../../src/core/types.js';
import { stringifyJson } from '../../src/lib/json.js';
import { createTarget } from '../../src/targets/index.js';
import {
  allKinds,
  cleanupTmp,
  fakeEnv,
  lockEntryOf,
  makeSource,
  readable,
  renderInput,
  snapshot,
  tmpDir,
  write,
} from './helpers.js';

/** Fault injection for `writeFileAtomic`: writes matching `failOn` throw EIO; every call is logged. */
const io = vi.hoisted(() => ({
  failOn: undefined as ((file: string) => boolean) | undefined,
  written: [] as string[],
}));

vi.mock('../../src/lib/fs.js', async (orig) => {
  const actual = (await orig()) as typeof import('../../src/lib/fs.js');
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      const [file] = args;
      if (io.failOn?.(file))
        throw Object.assign(new Error(`EIO: injected failure writing ${file}`), { code: 'EIO' });
      io.written.push(file);
      return actual.writeFileAtomic(...args);
    },
  };
});

afterEach(async () => {
  io.failOn = undefined;
  io.written = [];
  await cleanupTmp();
});

const CASES = TARGET_IDS.flatMap((t) =>
  (['project', 'global'] as const).map((s) => [t, s] as const),
);

describe.each(CASES)('golden render: %s @ %s', (id: TargetId, scope: Scope) => {
  it('pins the bytes of every kind', async () => {
    const root = await tmpDir();
    const src = await makeSource();
    const target = createTarget(id, fakeEnv(root));
    const out: Record<string, unknown> = {};
    for (const k of allKinds(src)) {
      const input = renderInput({ ...k, scope, scopeRoot: root, sourceRoot: src.root });
      out[k.label] = readable(await target.render(input), root);
    }
    expect(out).toMatchSnapshot();
  });
});

const MINE = { command: 'mine', args: ['--flag'] };

/** What a scope looks like when the user already works with every harness. */
const SEED: Record<Scope, Record<string, string>> = {
  project: {
    'palm.yaml': 'targets: []\n',
    '.claude/settings.json': stringifyJson({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }),
    '.mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.codex/config.toml': '# my codex config\nmodel = "gpt-6-astra" # favourite\n',
    '.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: mine\n---\n',
    '.github/copilot-instructions.md': '# House rules\n',
    '.vscode/mcp.json': stringifyJson({ servers: { mine: MINE } }),
    '.cursor/hooks.json': stringifyJson({ version: 1 }),
    '.cursor/mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    'AGENTS.md': '# Agents\n\nBe kind.\n',
    'GEMINI.md': '# Gemini rules\n\nBe brief.\n',
    '.gemini/settings.json': stringifyJson({ ui: { theme: 'GitHub' }, mcpServers: { mine: MINE } }),
    'opencode.json': stringifyJson({
      $schema: 'https://opencode.ai/config.json',
      instructions: ['CONTRIBUTING.md'],
      mcp: { mine: { type: 'local', command: ['mine', '--flag'] } },
    }),
    '.opencode/agents/mine.md': '---\ndescription: mine\n---\n',
    '.palm/assets/other/x/run.sh': '#!/bin/sh\n',
  },
  global: {
    '.claude/settings.json': stringifyJson({ theme: 'dark' }),
    '.claude.json': stringifyJson({ numStartups: 3, mcpServers: { mine: MINE } }),
    '.codex/config.toml': 'model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n',
    '.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: mine\n---\n',
    '.copilot/mcp-config.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.cursor/hooks.json': stringifyJson({ version: 1 }),
    '.cursor/mcp.json': stringifyJson({ mcpServers: { mine: MINE } }),
    '.gemini/GEMINI.md': '# Mine\n',
    '.gemini/settings.json': stringifyJson({
      hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine' }] }] },
    }),
    '.config/opencode/opencode.json': stringifyJson({ instructions: ['/abs/mine.md'] }),
    '.config/opencode/agents/mine.md': '---\ndescription: mine\n---\n',
    '.palm/palm.yaml': 'targets: []\n',
    '.palm/assets/other/x/run.sh': '#!/bin/sh\n',
  },
};

async function seeded(scope: Scope): Promise<string> {
  const root = await tmpDir();
  for (const [rel, content] of Object.entries(SEED[scope]))
    await write(path.join(root, ...rel.split('/')), content);
  return root;
}

describe.each(CASES)('round trip: %s @ %s', (id: TargetId, scope: Scope) => {
  it('render, apply and undeploy of every kind restores the scope byte for byte', async () => {
    const root = await seeded(scope);
    const before = await snapshot(root);
    const target = createTarget(id, fakeEnv(root));
    const src = await makeSource();
    const applied = [];
    for (const k of allKinds(src)) {
      const input = renderInput({ ...k, scope, scopeRoot: root, sourceRoot: src.root });
      const rendered = await target.render(input);
      const result = await target.apply({
        rendered,
        scopeRoot: root,
        owned: [],
        force: false,
        dryRun: false,
      });
      applied.push(lockEntryOf(k.entity, result));
      // pure: the populated destination does not change the render
      expect(await target.render(input)).toEqual(rendered);
    }
    expect(await snapshot(root)).not.toEqual(before);
    for (const entry of applied.reverse()) await target.undeploy(entry, scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});

/** The shared hooks file each harness merges into (copilot writes standalone files instead). */
const HOOK_MERGE_FILE: Record<TargetId, string | undefined> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  copilot: undefined,
  cursor: '.cursor/hooks.json',
  gemini: '.gemini/settings.json',
  opencode: undefined,
};

describe.each(CASES)('failed apply: %s @ %s', (id: TargetId, scope: Scope) => {
  async function renderKind(label: string, root: string) {
    const src = await makeSource();
    const k = allKinds(src).find((e) => e.label === label);
    if (!k) throw new Error(label);
    const target = createTarget(id, fakeEnv(root));
    const rendered = await target.render(
      renderInput({ ...k, scope, scopeRoot: root, sourceRoot: src.root }),
    );
    return { target, rendered, entity: k.entity };
  }

  it('a write failing after the merge step leaves the scope byte-identical', async () => {
    const root = await seeded(scope);
    const before = await snapshot(root);
    const { target, rendered } = await renderKind('hook', root);
    // The hook's scripts are written after its entries were merged into the shared hooks file.
    const assets = path.join(root, '.palm', 'assets');
    io.failOn = (file) => file.startsWith(`${assets}${path.sep}`);
    const applying = target.apply({
      rendered,
      scopeRoot: root,
      owned: [],
      force: false,
      dryRun: false,
    });
    if (id === 'opencode') await expect(applying).resolves.toMatchObject({ files: [] });
    else await expect(applying).rejects.toThrow(/injected failure/);
    const merged = HOOK_MERGE_FILE[id];
    if (merged) expect(io.written).toContain(path.join(root, merged)); // the merge was applied
    expect(await snapshot(root)).toEqual(before);
  });

  it('an MCP merge that fails leaves the scope byte-identical, and a retry succeeds', async () => {
    const root = await seeded(scope);
    const before = await snapshot(root);
    const { target, rendered, entity } = await renderKind('mcp stdio', root);
    const input = { rendered, scopeRoot: root, owned: [], force: false, dryRun: false };
    io.failOn = () => true;
    await expect(target.apply(input)).rejects.toThrow(/injected failure/);
    expect(await snapshot(root)).toEqual(before);
    io.failOn = undefined;
    const r = await target.apply(input);
    await target.undeploy(lockEntryOf(entity, r), scope, root, false);
    expect(await snapshot(root)).toEqual(before);
  });
});
