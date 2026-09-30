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
