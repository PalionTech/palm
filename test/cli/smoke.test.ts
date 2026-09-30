/**
 * The built binary (`node dist/cli.js`) as a person meets it: help, version, usage errors with
 * the fix on line one, the hidden 0.1 forms, a dry run that writes nothing, one JSON document,
 * and the PLAN.md 4.9 onboarding transcripts, which must equal the docs captures byte for byte.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Machine, writeFiles } from './world.js';

const repo = resolve(import.meta.dirname, '../..');
let m: Machine;
let project: string;

beforeAll(async () => {
  m = await Machine.create();
  project = await m.project('app');
});

afterAll(async () => {
  await m.dispose();
});

describe('palm CLI smoke', () => {
  it('--help lists the verbs, the utilities and the kinds, and no exit codes', async () => {
    const r = await m.palm(project, '--help');
    expect(r.code).toBe(0);
    for (const verb of [
      'init',
      'install (add, i)',
      'remove (uninstall, rm)',
      'update (up)',
      'check',
      'get (list, ls)',
      'describe (info)',
      'create (new)',
    ])
      expect(r.stdout).toContain(verb);
    const at = (s: string) => r.stdout.indexOf(s);
    expect(at('Verbs:')).toBeLessThan(at('Utilities:'));
    expect(at('Utilities:')).toBeLessThan(at('Options:'));
    expect(r.stdout).toContain('Kinds:');
    expect(r.stdout).not.toContain('origin');
    expect(r.stdout).not.toMatch(/exit code/i);
  });

  it('--version prints the package version', async () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
    const r = await m.palm(project, '--version');
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('install --help shows the forms, --all, --review and --snippet', async () => {
    const r = await m.palm(project, 'install', '--help');
    expect(r.code).toBe(0);
    for (const s of ['--all', '--review', '--snippet', 'palm install mcp --snippet <file or ->'])
      expect(r.stdout).toContain(s);
  });

  it('a word that is no repository exits 2 with the fix on line one (PLAN.md 4.9)', async () => {
    const r = await m.palm(project, 'install', 'tdd');
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n')[0]).toBe(
      'x "tdd" is not a repository. palm installs from git repositories:',
    );
    expect(r.stderr).toContain('palm install mattpocock/skills tdd');
  });

  it('an unknown option is a usage error (2); a removed verb names its replacement', async () => {
    const bogus = await m.palm(project, 'install', '--bogus');
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("unknown option '--bogus'");
    const doctor = await m.palm(project, 'doctor');
    expect(doctor.code).toBe(2);
    expect(doctor.stderr).toContain('palm doctor is now: palm check');
  });

  it('E4: palm install --frozen (the 0.1 CI line) says palm check and runs it', async () => {
    const r = await m.palm(project, 'install', '--frozen', '--yes');
    // Y12' R6': without palm.yaml check fails (a CI step never passes on an empty checkout)
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('i palm install --frozen is now: palm check');
    expect(r.stdout).toContain('no palm.yaml here');
    expect(r.stdout).not.toContain('no problems');
    expect(r.all).not.toContain('--force');
  });

  it('E19, D30: --version is the version in package.json', async () => {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
    expect((await m.palm(project, '--version')).stdout.trim()).toBe(pkg.version);
  });

  it('--dry-run writes nothing: no palm.yaml, no lock, no harness file', async () => {
    await writeFiles(project, {
      'kit/skills/review/SKILL.md': '---\nname: review\n---\nReview.\n',
    });
    const r = await m.palm(project, 'install', './kit', 'review', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('would install');
    for (const f of ['palm.yaml', 'palm.lock.yaml', '.claude/skills', '.palm'])
      expect(existsSync(join(project, f))).toBe(false);
  });

  it('--json prints one JSON document on stdout', async () => {
    const r = await m.palm(project, 'get', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ items: [], warnings: [] });
  });
});

describe('PLAN.md 4.9 onboarding transcripts', () => {
  /** The fenced block of PLAN.md section 4.9 that starts with `first`. */
  function planBlock(first: string): string {
    const plan = readFileSync(join(repo, 'PLAN.md'), 'utf8');
    const section = plan.slice(plan.indexOf('### 4.9 Onboarding'), plan.indexOf('### 4.10'));
    const start = section.indexOf(`\`\`\`\n${first}`);
    const body = section.slice(start + 4);
    return `${body.slice(0, body.indexOf('\n```'))}\n`;
  }

  it.each([
    ['a-onboarding-nora', '$ palm install superpowers'],
    ['a-onboarding-lena', '$ palm install tdd'],
  ])('%s is the real output of palm, byte for byte', (capture, first) => {
    const text = readFileSync(join(repo, 'docs/src/captures', `${capture}.txt`), 'utf8');
    expect(planBlock(first)).toBe(text);
  });
});
