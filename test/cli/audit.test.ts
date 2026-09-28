/**
 * `palm audit` (PLAN §2 item 11): hidden Unicode in the files palm installed, lock drift, --strip.
 * Runs in process (src/commands/main.ts) against hand-written lockfiles, so both the v1
 * `files: [path]` and the v2 `files: [{ path, hash }]` forms are covered.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runAudit } from '../../src/commands/audit.js';
import { hashPath } from '../../src/core/hash.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

const RLO = '‮';
const ZWSP = '​';
const TAG_A = String.fromCodePoint(0xe0061);

const EVIL = `---\nname: evil\n---\n\nBe helpful.${RLO}txt.exe\nline three${TAG_A}\n`;
const WARN = `# warn\n\nzero${ZWSP}width\n`;
const CLEAN = '﻿# clean\n\nnothing hidden, 👨‍👩‍👧 emoji are fine\n';

let sb: Sandbox;

async function put(abs: string, text: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
}

const lockYaml = (entries: string[]) => `version: 2\nentries:\n${entries.join('')}`;

const entry = (kind: string, name: string, files: string): string =>
  `  - kind: ${kind}\n    name: ${name}\n    origin: test\n    targets: [claude]\n    files:\n${files}`;

beforeEach(async () => {
  sb = await sandbox();
  const p = (rel: string) => join(sb.project, rel);
  await put(p('.claude/skills/evil/SKILL.md'), EVIL);
  await put(p('.claude/agents/warn.md'), WARN);
  await put(p('.claude/skills/clean/SKILL.md'), CLEAN);
  await put(p('.claude/skills/changed/SKILL.md'), 'edited by hand\n');
  const evilHash = await hashPath(p('.claude/skills/evil/SKILL.md'));
  await put(
    join(sb.project, 'palm.lock.yaml'),
    lockYaml([
      entry(
        'skill',
        'evil',
        `      - path: .claude/skills/evil/SKILL.md\n        hash: ${evilHash}\n`,
      ),
      entry('agent', 'warn', '      - .claude/agents/warn.md\n'),
      entry('skill', 'clean', '      - path: .claude/skills/clean/SKILL.md\n        hash: ""\n'),
      entry('skill', 'gone', '      - .claude/skills/gone/SKILL.md\n'),
      entry(
        'skill',
        'changed',
        '      - path: .claude/skills/changed/SKILL.md\n        hash: sha256:0000\n',
      ),
      entry('skill', 'escape', '      - ../outside.md\n'),
    ]),
  );
  await put(join(sb.root, 'outside.md'), `outside the project ${RLO}\n`);
});
afterEach(async () => removeDir(sb.root));

const cliEnv = () => ({ ...sb.env, NO_COLOR: '1', PATH: process.env.PATH });
const audit = (...args: string[]) =>
  runInProcess(['audit', ...args], { cwd: sb.project, env: cliEnv() });

describe('palm audit', () => {
  it('exits 1 on a critical finding and names file, counts and the first code point', async () => {
    const r = await audit();
    expect(r.code).toBe(1);
    const all = r.stdout + r.stderr;
    expect(all).toMatch(
      /x .*evil[/\\]SKILL\.md \(skill evil@test\): 2 critical; first: U\+202E RIGHT-TO-LEFT OVERRIDE at 5:12/,
    );
    expect(all).toMatch(
      /! .*warn\.md \(agent warn@test\): 1 warning; first: U\+200B ZERO WIDTH SPACE at 3:5/,
    );
    expect(all).toMatch(/gone[/\\]SKILL\.md .*: missing/);
    expect(all).toMatch(/changed[/\\]SKILL\.md .*: changed since install/);
    expect(all).not.toMatch(/clean[/\\]SKILL\.md/);
    expect(all).not.toContain('outside.md');
    expect(all).toContain('palm audit --strip');
  });

  it('--json: one document with every finding, still exit 1', async () => {
    const r = await audit('--json');
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.scanned).toBe(5);
    expect(doc.remaining).toEqual({ critical: 2, warning: 1 });
    expect(doc.drifted).toBe(2);
    const evil = doc.files.find((f: { entity: string }) => f.entity === 'skill evil@test');
    expect(evil.findings).toEqual([
      {
        severity: 'critical',
        codePoint: 0x202e,
        name: 'RIGHT-TO-LEFT OVERRIDE',
        line: 5,
        column: 12,
      },
      {
        severity: 'critical',
        codePoint: 0xe0061,
        name: 'TAG LATIN SMALL LETTER A',
        line: 6,
        column: 11,
      },
    ]);
    expect(Array.isArray(doc.warnings)).toBe(true);
  });

  it('warnings only: printed, exit 0 (kind and name narrow the scan)', async () => {
    const ctx = await makeContext(sb);
    const report = await runAudit(ctx, { scopes: ['project'], kind: 'agent', names: ['warn'] });
    expect(report.scanned).toBe(1);
    expect(report.remaining).toEqual({ critical: 0, warning: 1 });
    const r = await audit('agent', 'warn');
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain('1 with hidden Unicode');
  });

  it('--strip removes every finding, keeps everything else, records the new hash; the next audit is clean', async () => {
    const r = await audit('--strip');
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/evil[/\\]SKILL\.md .*: removed 2 hidden characters/);
    const evilFile = join(sb.project, '.claude/skills/evil/SKILL.md');
    expect(await readFile(evilFile, 'utf8')).toBe(EVIL.replace(RLO, '').replace(TAG_A, ''));
    expect(await readFile(join(sb.project, '.claude/agents/warn.md'), 'utf8')).toBe(
      WARN.replace(ZWSP, ''),
    );
    expect(await readFile(join(sb.project, '.claude/skills/clean/SKILL.md'), 'utf8')).toBe(CLEAN);
    expect(await readFile(join(sb.root, 'outside.md'), 'utf8')).toContain(RLO);

    const lock = parse(await readFile(join(sb.project, 'palm.lock.yaml'), 'utf8'));
    const locked = lock.entries.find((e: { name: string }) => e.name === 'evil');
    expect(locked.files[0].hash).toBe(await hashPath(evilFile));

    const again = await audit('--json');
    expect(again.code).toBe(0);
    const doc = JSON.parse(again.stdout);
    expect(doc.remaining).toEqual({ critical: 0, warning: 0 });
    expect(doc.files.every((f: { findings: unknown[] }) => f.findings.length === 0)).toBe(true);
  });

  it('--strip --dry-run changes nothing and still exits 1', async () => {
    const r = await audit('--strip', '--dry-run');
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('would remove 2 hidden characters');
    expect(await readFile(join(sb.project, '.claude/skills/evil/SKILL.md'), 'utf8')).toBe(EVIL);
  });

  it('-g scans only the global lock; by default both scopes are scanned', async () => {
    const globalFile = join(sb.home, '.claude', 'skills', 'g', 'SKILL.md');
    await put(globalFile, `global ${RLO}\n`);
    await put(
      join(sb.palmHome, 'palm.lock.yaml'),
      lockYaml([entry('skill', 'g', `      - ${globalFile}\n`)]),
    );
    const g = JSON.parse((await audit('-g', '--json')).stdout);
    expect(g.scanned).toBe(1);
    expect(g.files.map((f: { scope: string }) => f.scope)).toEqual(['global']);
    const both = JSON.parse((await audit('--json')).stdout);
    expect(both.scanned).toBe(6);
    expect(new Set(both.files.map((f: { scope: string }) => f.scope))).toEqual(
      new Set(['project', 'global']),
    );
  });

  it('nothing installed: exit 0', async () => {
    const empty = join(sb.root, 'empty');
    await mkdir(join(empty, '.git'), { recursive: true });
    const r = await runInProcess(['audit'], { cwd: empty, env: cliEnv() });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain('0 files scanned; no hidden Unicode');
  });
});
