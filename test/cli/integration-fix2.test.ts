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
