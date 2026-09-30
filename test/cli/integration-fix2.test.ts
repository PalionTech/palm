/**
 * The second persona rerun's rulings wired at integration (FINDINGS-v3.md), proven against the
 * built binary with real git sources, targets and cache.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Files, git, Machine, writeFiles } from './world.js';

const skill = (name: string, body = 'Use it.'): Files => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
});

let m: Machine;
beforeEach(async () => {
  m = await Machine.create();
});
afterEach(async () => {
  await m.dispose();
});

/** A project whose committed palm.yaml names `url` (a file:// source outside it) as `kit`. */
async function clonedWith(url: string): Promise<string> {
  const first = await m.project('app');
  expect((await m.palm(first, 'install', url, 'tdd', '--as', 'kit')).code).toBe(0);
  await git(first, 'add', '-A');
  await git(first, 'commit', '-qm', 'palm');
  const clone = join(m.root, 'clone');
  await git(m.root, 'clone', '-q', first, clone);
  return clone;
}

/** 24 distinct characters; token bodies are built from them at runtime. */
const RANDOM = 'Zx8kQ2mN7pL4vR9tW3yB6cF1';

describe("S6 J3' Y2' a server palm just wrote literally", () => {
  it("S6 J3' check finds no render mismatch right after --secrets literal", async () => {
    const p = await m.project('app');
    await writeFiles(m.palmHome, { 'palm.yaml': 'targets: [claude]\n' });
    const header = ['--header', `X-Api-Key=${RANDOM}${RANDOM}`, '--secrets', 'literal'];
    const args = ['install', 'mcp', 'docs', '--url', 'https://docs.example.com/mcp', ...header];
    const global = await m.palm(p, ...args, '-g');
    expect(global.code, global.all).toBe(0);
    const check = await m.palm(p, 'check', '-g');
    expect(check.all).not.toContain('renders differently');
    expect(check.code, check.all).toBe(0);
  });
});

describe("Y1' J2' servers typed with flags", () => {
  it("Y1' a ${VAR} header is header auth in the typed and the bare install alike", async () => {
    const p = await m.project('app', ['.claude', '.opencode']);
    await writeFiles(p, { 'palm.yaml': 'targets: [claude, opencode]\n' });
    const url = ['--url', 'https://docs.example.com/mcp'];
    const add = await m.palm(p, 'install', 'mcp', 'docs', ...url, '--header', 'X-Key=${DOCS_KEY}');
    expect(add.code, add.all).toBe(0);
    const typed = readFileSync(join(p, 'opencode.json'), 'utf8');
    expect(typed).toContain('"oauth": false');
    expect((await m.palm(p, 'install')).code).toBe(0);
    expect(readFileSync(join(p, 'opencode.json'), 'utf8')).toBe(typed);
  });

  it("J2' a typed value that is no secret is written as typed, and a line says so", async () => {
    const p = await m.project('app');
    await writeFiles(p, { 'palm.yaml': 'targets: [claude]\n' });
    const url = ['--url', 'https://docs.example.com/mcp'];
    const run = await m.palm(p, 'install', 'mcp', 'docs', ...url, '--header', 'X-Region=eu');
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain('docs: headers.X-Region is written as you typed it (not a secret)');
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toContain('"X-Region": "eu"');
  });
});

const agentMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: sonnet\n---\nReview.\n`;

describe('N1 O21 S13 the listing and the install say what the index left out', () => {
  it('N1 near misses print in the listing, at install, and in the not-found error', async () => {
    const url = await m.source('kit', {
      'v1.0.0': { ...skill('tdd'), 'people/reviewer.md': agentMd('reviewer') },
    });
    const p = await m.project('app');
    const listed = await m.palm(p, 'install', url);
    expect(listed.all).toContain('1 agent-shaped file not indexed: people/reviewer.md');
    expect(listed.all).toContain(`to index them: palm install ${url} --layout`);
    const missing = await m.palm(p, 'install', url, 'reviewer');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('people/reviewer.md looks like an agent but is not indexed');
    expect(missing.stderr).toContain(
      "reviewer --layout 'skills=skills/*' --layout agents=people/reviewer.md",
    );
    const installed = await m.palm(p, 'install', url, 'tdd', '--as', 'kit');
    expect(installed.code, installed.all).toBe(0);
    expect(installed.all).toContain('kit: 1 agent-shaped file not indexed: people/reviewer.md');
    expect(installed.all).toContain('add layout: {');
  });

  it('O21 S13 a hook row names its whole command; a refused entity is marked, never offered', async () => {
    const hooks = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'go run .agents/hooks/main.go' }] }] },
    };
    const url = await m.source('kit', {
      'v1.0.0': {
        'hooks/guard/hooks.json': JSON.stringify(hooks),
        ...skill('sneaky', 'Use it.‮ hidden'),
      },
    });
    const p = await m.project('app');
    const listed = await m.palm(p, 'install', url);
    expect(listed.stdout).toContain('claude: Stop -> go run .agents/hooks/main.go');
    expect(listed.stdout).toMatch(/sneaky .*\(refused: hidden Unicode\)/);
    expect(listed.stdout).toContain(`palm install ${url} hook:guard`);
    expect(listed.stdout).not.toContain('--all');
  });
});

describe('Y11 M21 check on in-repo sources and adopted commands', () => {
  it("M21 Y11' a placeholder description and a command beside its skill warn", async () => {
    const p = await m.project('app');
    await writeFiles(p, { 'palm.yaml': 'targets: [claude]\n' });
    const created = await m.palm(p, 'create', 'skill', 'deploy');
    expect(created.code, created.all).toBe(0);
    await writeFiles(p, { '.claude/commands/deploy.md': 'Deploy it.\n' });
    const check = await m.palm(p, 'check');
    expect(check.stdout).toContain('skill deploy still has the placeholder description');
    expect(check.stdout).toContain('write its description in agent-kit/skills/deploy/SKILL.md');
    expect(check.stdout).toContain(
      '.claude/commands/deploy.md answers to /deploy like the installed skill deploy',
    );
  });
});

describe("R20' M8 describe", () => {
  it("R20' a server's block reads in its file's language: TOML for Codex", async () => {
    const p = await m.project('app', ['.claude', '.codex']);
    await writeFiles(p, { 'palm.yaml': 'targets: [claude, codex]\n' });
    const url = ['--url', 'https://docs.example.com/mcp'];
    expect((await m.palm(p, 'install', 'mcp', 'docs', ...url)).code).toBe(0);
    const described = await m.palm(p, 'describe', 'mcp:docs');
    expect(described.stdout).toContain('[mcp_servers.docs]');
    expect(described.stdout).toContain('"url": "https://docs.example.com/mcp"');
  });

  it('M8 describe notes a kept member that mentions an excluded one', async () => {
    const url = await m.source('sp', {
      'v1.0.0': {
        '.claude-plugin/plugin.json': JSON.stringify({ name: 'sp', version: '1.0.0' }),
        ...skill('plans', 'Then use sp:reviews to check.'),
        ...skill('reviews'),
      },
    });
    const p = await m.project('app');
    const run = await m.palm(p, 'install', url, 'plugin:sp', '--as', 'sp');
    expect(run.code, run.all).toBe(0);
    const yaml = readFileSync(join(p, 'palm.yaml'), 'utf8');
    await writeFiles(p, {
      'palm.yaml': yaml.replace('plugins: [sp]', 'plugins: [{name: sp, exclude: [skill:reviews]}]'),
    });
    expect((await m.palm(p, 'install', '--allow-local-sources')).code).toBe(0);
    const described = await m.palm(p, 'describe', 'skill:plans');
    expect(described.stdout).toContain('skill plans mentions sp:reviews, which palm.yaml excludes');
  });
});

describe('O2 a project that ignores its output folders on purpose', () => {
  it('O2 migrate warns with the exact re-include lines and does not fail on them', async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd') });
    const sha = (await git(m.root, 'ls-remote', url, 'refs/tags/v1.0.0')).split('\t')[0];
    const p = await m.project('app');
    await writeFiles(m.palmHome, {
      'config.yaml': `origins:\n  - alias: kit\n    type: git\n    url: ${url}\n`,
    });
    await writeFiles(p, {
      '.gitignore': '.claude/\n',
      'palm.yaml': 'targets: [claude]\nskills:\n  - tdd@kit\n',
      'palm.lock.yaml': `version: 2\nentries:\n  - { kind: skill, name: tdd, origin: kit, ref: v1.0.0, sha: ${sha}, path: skills/tdd, targets: [claude] }\n`,
    });
    const run = await m.palm(p, 'migrate');
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain(
      'in .gitignore, write .claude/* where it says .claude/, then add !.claude/skills/ below it',
    );
  });
});

describe('X20 O11 what the write found already there', () => {
  it('X20 a file already there with the same content is adopted, and the row says so', async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd') });
    const p = await m.project('app');
    await writeFiles(p, {
      '.claude/skills/tdd/SKILL.md': skill('tdd')['skills/tdd/SKILL.md'] as string,
    });
    const run = await m.palm(p, 'install', url, 'tdd', '--as', 'kit');
    expect(run.code, run.all).toBe(0);
    expect(run.stdout).toContain(
      'adopted .claude/skills/tdd/SKILL.md already there (the same content)',
    );
  });
});

describe("J8' create writes into the in-repo source the scope declares", () => {
  it("J8' with one in-repo source declared, create uses it, not ./agent-kit", async () => {
    const p = await m.project('app');
    await writeFiles(p, { 'palm.yaml': 'targets: [claude]\n' });
    await writeFiles(join(p, 'team-kit'), skill('tdd'));
    expect((await m.palm(p, 'install', './team-kit', 'tdd')).code).toBe(0);
    const created = await m.palm(p, 'create', 'skill', 'deploy', '--description', 'Deploys');
    expect(created.code, created.all).toBe(0);
    expect(readFileSync(join(p, 'team-kit/skills/deploy/SKILL.md'), 'utf8')).toContain('Deploys');
  });
});

describe("S4' a committed palm.yaml naming a file:// source outside the project", () => {
  it("S4' a bare install and check are refused with the flag that allows them", async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd') });
    const clone = await clonedWith(url);
    const install = await m.palm(clone, 'install');
    expect(install.code, install.all).toBe(1);
    expect(install.stderr).toContain(`source "kit" is ${url}, outside the project`);
    expect(install.stderr).toContain('palm install --allow-local-sources');
    const check = await m.palm(clone, 'check');
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('palm check --allow-local-sources');
    const allowed = await m.palm(clone, 'install', '--allow-local-sources');
    expect(allowed.code, allowed.all).toBe(0);
    expect(readFileSync(join(clone, '.claude/skills/tdd/SKILL.md'), 'utf8')).toContain('Use it.');
    expect((await m.palm(clone, 'check', '--allow-local-sources')).code).toBe(0);
    expect(readFileSync(join(clone, 'palm.lock.yaml'), 'utf8')).not.toContain('file:///');
  });
});
