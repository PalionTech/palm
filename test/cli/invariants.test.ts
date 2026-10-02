/**
 * PLAN.md 4.5 invariants that only hold when every layer works together, proven against the
 * built binary with real git sources (local bare repositories), real targets, index, exec and
 * secrets. Each test names the invariants it proves; the area tests cover the rest with fakes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowExecOf, type Files, git, Machine, writeFiles } from './world.js';

const skill = (name: string, body: string): Files => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`,
});

const hookKit = (script: string): Files => ({
  ...skill('review', 'Review carefully.'),
  'hooks/guard/hooks.json': JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/guard.sh"' }] },
      ],
    },
  }),
  'hooks/guard/scripts/guard.sh': { text: script, mode: 0o755 },
});

let m: Machine;
beforeEach(async () => {
  m = await Machine.create();
});
afterEach(async () => {
  await m.dispose();
});

/** A literal that looks like a secret to palm, built at runtime (never committed as such). */
function highEntropy(): string {
  return ['q7Lm2Vx9', 'Rt4Kp8Wz', 'Bn3Hs6Yd', 'Jc5Gf1Ua'].join('');
}

describe('portable, rebuildable state', () => {
  it('invariants 1 and 2: no home, palm home, hostname or timestamp in the files; the lock rebuilds anywhere', async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd', 'Test first.') });
    const p = await m.project('app');
    expect((await m.palm(p, 'install', url, 'tdd', '--as', 'kit')).code).toBe(0);
    expect((await m.palm(p, 'install', '-g', url, 'tdd', '--as', 'kit')).code).toBe(2);
    await writeFiles(m.home, { '.claude/.keep': '' });
    expect((await m.palm(p, 'install', '-g', url, 'tdd', '--as', 'kit')).code).toBe(0);
    for (const f of [
      join(p, 'palm.yaml'),
      join(p, 'palm.lock.yaml'),
      join(m.palmHome, 'palm.yaml'),
      join(m.palmHome, 'palm.lock.yaml'),
    ]) {
      const text = readFileSync(f, 'utf8');
      expect(text).not.toContain(m.home);
      expect(text).not.toContain(hostname());
      expect(text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    }
    const lock = readFileSync(join(p, 'palm.lock.yaml'), 'utf8');
    expect(lock).toMatch(/sha: [0-9a-f]{40}/);
    expect(readFileSync(join(m.palmHome, 'palm.lock.yaml'), 'utf8')).toContain('<claude>/skills');
  });

  it('invariants 3 and 4: a clean clone passes check and a bare install writes nothing; drift fails check', async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd', 'Test first.') });
    const p = await m.project('app');
    await m.palm(p, 'install', url, 'tdd', '--as', 'kit');
    await git(p, 'add', '-A');
    await git(p, 'commit', '-qm', 'setup');
    const clone = join(m.root, 'clone');
    await git(m.root, 'clone', '-q', p, clone);
    const other = await Machine.create();
    try {
      expect((await other.palm(clone, 'check', '--allow-local-sources')).code).toBe(0);
      const sync = await other.palm(clone, 'install', '--allow-local-sources');
      expect(sync.code).toBe(0);
      expect(sync.stdout).toContain('1 unchanged.');
      expect(await git(clone, 'status', '--porcelain')).toBe('');
      await writeFiles(clone, { '.claude/skills/tdd/SKILL.md': 'edited\n' });
      const check = await other.palm(clone, 'check', '--allow-local-sources');
      expect(check.code).toBe(1);
      expect(check.stdout).toContain('x 1 generated file differs from the lock');
    } finally {
      await other.dispose();
    }
  });
});

describe('sources and versions', () => {
  it('invariant 5: update moves the sha within the range, --to moves the range', async () => {
    const url = await m.source('kit', {
      'v1.0.0': skill('tdd', 'one'),
      'v1.1.0': skill('tdd', 'two'),
      'v2.0.0': skill('tdd', 'three'),
    });
    const p = await m.project('app');
    await m.palm(p, 'install', `${url}#^1.0`, 'tdd', '--as', 'kit');
    expect(readFileSync(join(p, '.claude/skills/tdd/SKILL.md'), 'utf8')).toContain('two');
    await m.release('kit', 'v1.2.0', skill('tdd', 'four'));
    expect((await m.palm(p, 'update', '--yes', '--allow-local-sources')).code).toBe(0);
    expect(readFileSync(join(p, '.claude/skills/tdd/SKILL.md'), 'utf8')).toContain('four');
    expect(readFileSync(join(p, 'palm.yaml'), 'utf8')).toContain('ref: ^1.0');
    expect(
      (await m.palm(p, 'update', 'kit', '--to', '^2.0', '--yes', '--allow-local-sources')).code,
    ).toBe(0);
    expect(readFileSync(join(p, 'palm.yaml'), 'utf8')).toContain('ref: ^2.0');
    expect(readFileSync(join(p, '.claude/skills/tdd/SKILL.md'), 'utf8')).toContain('three');
  });

  it('invariant 6: an in-repo source is the truth; check fails on drift until a bare install re-renders', async () => {
    const p = await m.project('app');
    await writeFiles(join(p, 'kit'), skill('review', 'v1'));
    expect((await m.palm(p, 'install', './kit', 'review')).code).toBe(0);
    await writeFiles(join(p, 'kit'), skill('review', 'v2'));
    expect((await m.palm(p, 'check')).code).toBe(1);
    const sync = await m.palm(p, 'install');
    expect(sync.stdout).toContain('~ skill  review');
    expect(readFileSync(join(p, '.claude/skills/review/SKILL.md'), 'utf8')).toContain('v2');
    expect((await m.palm(p, 'check')).code).toBe(0);
  });

  it('invariant 7: a pulled lock that moved is an upgrade, never "your edits" (dotfiles, -g)', async () => {
    const url = await m.source('kit', { 'v1.0.0': skill('tdd', 'one') });
    const p = await m.project('app');
    await writeFiles(m.home, { '.claude/.keep': '' });
    await m.palm(p, 'install', '-g', `${url}#^1.0`, 'tdd', '--as', 'kit');
    // A second machine gets ~/.palm/palm.yaml and the lock from the same dotfiles repository.
    const other = await Machine.create();
    try {
      await writeFiles(other.home, {
        '.claude/.keep': '',
        '.palm/palm.yaml': readFileSync(join(m.palmHome, 'palm.yaml'), 'utf8'),
        '.palm/palm.lock.yaml': readFileSync(join(m.palmHome, 'palm.lock.yaml'), 'utf8'),
      });
      expect((await other.palm(p, 'install', '-g')).code).toBe(0);
      await m.release('kit', 'v1.1.0', skill('tdd', 'two'));
      expect((await m.palm(p, 'update', '-g', '--yes')).code).toBe(0);
      await writeFiles(other.home, {
        '.palm/palm.lock.yaml': readFileSync(join(m.palmHome, 'palm.lock.yaml'), 'utf8'),
      });
      const sync = await other.palm(p, 'install', '-g');
      expect(sync.code, sync.all).toBe(0);
      expect(sync.stdout, sync.all).toMatch(/^[~↺] skill {2}tdd/m);
      expect(sync.all).not.toContain('modified');
      const file = join(other.home, '.claude/skills/tdd/SKILL.md');
      expect(readFileSync(file, 'utf8')).toContain('two');
    } finally {
      await other.dispose();
    }
  });
});

describe('exact, symmetric removal', () => {
  it('invariant 8: removal takes exactly what palm wrote; a foreign entry survives; absent is not an error', async () => {
    const p = await m.project('app');
    const before = '{\n  "mcpServers": {\n    "mine": {\n      "command": "mine"\n    }\n  }\n}\n';
    await writeFiles(p, { '.mcp.json': before });
    const add = await m.palm(p, 'install', 'mcp', 'docs', '--url', 'https://example.com/mcp');
    expect(add.code).toBe(0);
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toContain('"docs"');
    expect((await m.palm(p, 'remove', 'docs')).code).toBe(0);
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toBe(before);
    const again = await m.palm(p, 'remove', 'docs');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('is not installed');
  });
});

describe('programs and consent', () => {
  it('invariants 10, 11 and 21: no program without a pinned consent, --yes never consents, a changed hash asks again', async () => {
    const url = await m.source('kit', { 'v1.0.0': hookKit('echo one\n') });
    const p = await m.project('app');
    const ask = await m.palm(p, 'install', url, 'hook:guard', '--as', 'kit', '--yes');
    expect(ask.code).toBe(1);
    expect(ask.stderr).toContain('needs your consent and there is no terminal');
    expect(existsSync(join(p, '.claude/settings.json'))).toBe(false);
    const allow = allowExecOf(ask.all);
    const ok = await m.palm(p, 'install', url, 'hook:guard', '--as', 'kit', '--allow-exec', allow);
    expect(ok.code).toBe(0);
    expect((await m.palm(p, 'install', '--allow-local-sources')).code).toBe(0);
    await m.release('kit', 'v1.1.0', hookKit('echo two\n'));
    const update = await m.palm(p, 'update', '--yes', '--allow-local-sources');
    expect(update.code).toBe(1);
    expect(update.stderr).toContain('needs your consent and there is no terminal');
    expect(
      readFileSync(join(p, '.palm/assets/kit/guard/hooks/guard/scripts/guard.sh'), 'utf8'),
    ).toBe('echo one\n');
  });

  it('invariant 13: every script a hook runs is committed with the repository', async () => {
    const url = await m.source('kit', { 'v1.0.0': hookKit('echo one\n') });
    const p = await m.project('app');
    const ask = await m.palm(p, 'install', url, 'hook:guard', '--as', 'kit');
    await m.palm(
      p,
      'install',
      url,
      'hook:guard',
      '--as',
      'kit',
      '--allow-exec',
      allowExecOf(ask.all),
    );
    await git(p, 'add', '-A');
    await git(p, 'commit', '-qm', 'hook');
    const settings = readFileSync(join(p, '.claude/settings.json'), 'utf8');
    const script = /\.palm\/assets\/[^"\s]+\.sh/.exec(settings)?.[0];
    expect(script).toBeDefined();
    expect(await git(p, 'ls-files', '--', script as string)).toBe(script);
    expect((await m.palm(p, 'check', '--allow-local-sources')).stdout).toContain(
      '✓ every hook script exists',
    );
  });

  it('invariant 14: palm never merges a command it could not resolve', async () => {
    const kit: Files = {
      'hooks/broken/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash ./scripts/missing.sh' }] }] },
      }),
    };
    const url = await m.source('kit', { 'v1.0.0': kit });
    const p = await m.project('app');
    const r = await m.palm(p, 'install', url, 'hook:broken', '--as', 'kit', '--allow-exec', 'all');
    expect(r.code).not.toBe(0);
    expect(existsSync(join(p, '.claude/settings.json'))).toBe(false);
  });
});

describe('secrets', () => {
  it('invariant 15: a literal secret from a source is never written, not even with --force', async () => {
    const literal = highEntropy();
    const kit: Files = {
      '.mcp.json': JSON.stringify({
        mcpServers: { docs: { url: 'https://example.com/mcp', headers: { 'x-api-key': literal } } },
      }),
    };
    const url = await m.source('kit', { 'v1.0.0': kit });
    const p = await m.project('app');
    const r = await m.palm(p, 'install', url, 'mcp:docs', '--as', 'kit', '--force');
    expect(r.code).toBe(0);
    expect(r.all).toContain('written as ${DOCS_API_KEY}');
    for (const f of ['.mcp.json', 'palm.yaml', 'palm.lock.yaml'])
      expect(readFileSync(join(p, f), 'utf8')).not.toContain(literal);
    expect(readFileSync(join(p, '.mcp.json'), 'utf8')).toContain('${DOCS_API_KEY}');
  });
});

describe('honest statuses and dry runs', () => {
  it('invariants 19 and 23: a dry run reports exactly what the run writes; unchanged means unchanged', async () => {
    const url = await m.source('kit', {
      'v1.0.0': { ...skill('tdd', 'one'), ...skill('grill', 'two') },
    });
    const p = await m.project('app', ['.claude', '.codex']);
    const dry = await m.palm(p, 'install', url, 'tdd', 'grill', '--as', 'kit', '--dry-run');
    expect(dry.stdout).toContain('dry run: 2 would install; nothing written.');
    expect(existsSync(join(p, 'palm.yaml'))).toBe(false);
    const real = await m.palm(p, 'install', url, 'tdd', 'grill', '--as', 'kit');
    expect(real.stdout).toContain('2 installed.');
    // kind, name, where and how many files: what the run writes, row by row
    const rows = (s: string) =>
      s
        .split('\n')
        .filter((l) => /^\+ (would install {2})?(skill|agent)/.test(l))
        .map((l) =>
          l
            .replace(/^\+ would install {2}/, '+ ')
            .split(/ {3}/)
            .slice(0, 3)
            .join(' '),
        );
    expect(rows(dry.stdout)).toEqual(rows(real.stdout));
    const sync = await m.palm(p, 'install', '--allow-local-sources');
    expect(sync.stdout).toContain('2 unchanged.');
    await writeFiles(p, { '.agents/skills/tdd/SKILL.md': 'edited\n' });
    const kept = await m.palm(p, 'install', '--allow-local-sources');
    expect(kept.code).toBe(1);
    expect(kept.stdout).toContain('modified (kept)');
  });

  it('invariant 20: an error names the command to run next, never a placeholder alone', async () => {
    const p = await m.project('app');
    const r = await m.palm(p, 'install', 'superpowers');
    const [first, hint] = r.stderr.split('\n');
    expect(first).toMatch(/^x "superpowers" is not a repository/);
    expect(hint).toContain('palm install obra/superpowers');
    const empty = await m.palm(p, 'get');
    expect(empty.all).not.toMatch(/: palm \S+ <[a-z/]+>\s*$/m);
  });
});
