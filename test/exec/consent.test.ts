import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ClosureFile, ConsentRequest, ExecUnit } from '../../src/core/types.js';
import {
  allowed,
  askConsent,
  checkoutReader,
  consentText,
  nonInteractiveError,
  parseAllowExec,
  viewScripts,
} from '../../src/exec/consent.js';
import { consentSummary } from '../../src/exec/prompt.js';
import { designBlock, ghCliUnit, teamHelperUnit } from './examples.js';
import { fakeContext } from './fakes.js';

const git = vi.hoisted(() => ({
  fileAtSha: vi.fn(
    async (_dir: string, _sha: string, _rel: string): Promise<string | undefined> =>
      'echo from git\n',
  ),
}));

vi.mock('../../src/core/git.js', async (real) => ({ ...(await real()), ...git }));

/** The DESIGN.md example request: gh-cli and team-helper, one prompt hook. */
function exampleRequest(overrides: Partial<ConsentRequest> = {}): ConsentRequest {
  return {
    operation: 'install',
    units: [ghCliUnit(), teamHelperUnit()],
    prompts: [{ entity: 'fp-check', event: 'Stop' }],
    lockFile: '/work/app/palm.lock.yaml',
    ...overrides,
  };
}

const PROJECT = { scope: 'project' as const, lockFile: 'palm.lock.yaml' };
const bodies = async (unit: ExecUnit, file: ClosureFile) =>
  `# ${unit.entity.name}:${file.path}\necho hi\n`;

describe('parseAllowExec', () => {
  it('reads nothing, all, and comma-separated key=hash entries', () => {
    expect(parseAllowExec(undefined)).toEqual([]);
    expect(parseAllowExec('  ')).toEqual([]);
    expect(parseAllowExec('all')).toBe('all');
    expect(parseAllowExec('ALL')).toBe('all');
    expect(
      parseAllowExec(
        'hook:gh-cli@trailofbits/skills=sha256:a7cc7911f2bd0a61, mcp:team-helper@acme-kit=75AAFD9B00112233',
      ),
    ).toEqual([
      { key: 'hook:gh-cli@trailofbits/skills', hash: 'sha256:a7cc7911f2bd0a61' },
      { key: 'mcp:team-helper@acme-kit', hash: 'sha256:75aafd9b00112233' },
    ]);
    expect(parseAllowExec(`hook:quality@./agent-kit=sha256:${'f'.repeat(64)}`)).toEqual([
      { key: 'hook:quality@./agent-kit', hash: `sha256:${'f'.repeat(64)}` },
    ]);
  });

  it.each([
    ['a hash under 16 hex digits', 'hook:gh-cli@trailofbits/skills=sha256:a7cc7911f2bd0a6'],
    ['a hash over 64 hex digits', `hook:gh-cli@t/s=sha256:${'a'.repeat(65)}`],
    ['a hash that is not hex', 'hook:gh-cli@t/s=sha256:a7cc79zzf2bd0a61'],
    ['no hash', 'hook:gh-cli@trailofbits/skills'],
    ['no source', 'hook:gh-cli=sha256:a7cc7911f2bd0a61'],
    ['a kind that runs nothing', 'skill:tdd@mattpocock/skills=sha256:a7cc7911f2bd0a61'],
    ['all inside a list', 'all,hook:gh-cli@t/s=sha256:a7cc7911f2bd0a61'],
  ])('rejects %s with the format in the hint', (_label, text) => {
    expect(() => parseAllowExec(text)).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        hint: expect.stringContaining('<hook|mcp>:<name>@<source>=sha256:<16 or more hex digits>'),
      }),
    );
  });
});

describe('allowed', () => {
  const unit = ghCliUnit();
  const prefix = unit.hash.slice(0, 'sha256:'.length + 8);

  it('matches the key in any case with a hash prefix or the full hash', () => {
    expect(allowed(unit, 'all')).toBe(true);
    expect(allowed(unit, [{ key: unit.key, hash: prefix }])).toBe(true);
    expect(allowed(unit, [{ key: unit.key.toUpperCase(), hash: unit.hash }])).toBe(true);
  });

  it('refuses another key, another hash and an empty list', () => {
    expect(allowed(unit, [])).toBe(false);
    expect(allowed(unit, [{ key: 'hook:other@trailofbits/skills', hash: prefix }])).toBe(false);
    expect(allowed(unit, [{ key: unit.key, hash: 'sha256:00000000' }])).toBe(false);
  });
});

describe('consentText', () => {
  it('reproduces the DESIGN section 7 prompt from the example units', () => {
    expect(consentText(exampleRequest(), PROJECT)).toBe(designBlock('The prompt:'));
  });

  it('speaks of one program and offers the diff when a trusted version exists', () => {
    const unit = teamHelperUnit();
    const text = consentText(
      {
        operation: 'install',
        units: [unit],
        prompts: [],
        lockFile: 'x',
        previous: { [unit.key]: unit },
      },
      PROJECT,
    );
    expect(text.split('\n')[0]).toBe('This install changes 1 program that runs on your machine.');
    expect(text).toContain(
      'palm never runs this itself. If you say yes, its hash goes into palm.lock.yaml,\nso teammates and CI install it without being asked; any change asks again.',
    );
    expect(text.endsWith('Allow this program to run?  [y/N/v=view scripts/d=diff]')).toBe(true);
    expect(text).not.toContain('Also');
  });

  it('names the other machines and no commit line under -g', () => {
    const text = consentText(exampleRequest(), {
      scope: 'global',
      lockFile: '~/.palm/palm.lock.yaml',
    });
    expect(text).toContain(
      'scripts: 8 files, 21 KB  ->  .palm/assets/trailofbits__skills/gh-cli/\n',
    );
    expect(text).toContain('go into ~/.palm/palm.lock.yaml,\nso your other machines install them');
  });

  it('X16 J16 M14 Q13 names skipped targets, reads ~/ paths, and says --review without a prompt', () => {
    const unit: ExecUnit = {
      ...ghCliUnit(),
      skipped: { copilot: 'hooks gh-cli: nothing GitHub Copilot can run' },
      closure: { ...ghCliUnit().closure, root: '<palm>/assets/trailofbits__skills/gh-cli' },
      rendered: {
        claude: [
          { id: 'PreToolUse//Bash', command: '/h/.palm/run.sh', file: '<claude>/settings.json' },
        ],
      },
    };
    const shown = (t: string) =>
      t.replace('<claude>/', '~/.claude/').replace('<palm>/', '~/.palm/').split('/h/').join('~/');
    const req = { operation: 'install' as const, units: [unit], prompts: [], lockFile: '' };
    const opts = { scope: 'global' as const, lockFile: '~/.palm/palm.lock.yaml', shown };
    const text = consentText(req, opts);
    expect(text).toContain('skipped: copilot (hooks gh-cli: nothing GitHub Copilot can run)');
    expect(text).toContain('targets: claude (~/.claude/settings.json)');
    expect(text).toContain('->  ~/.palm/assets/trailofbits__skills/gh-cli/');
    expect(text).toContain('~/.palm/run.sh');
    expect(text).not.toMatch(/<(home|palm|claude)>/);
    expect(text).toContain('(v shows every script)');
    expect(consentSummary(req, { ...opts, noPrompt: true })).toContain(
      '(--review shows every script)',
    );
  });

  it('M14 under -g the printed block reads ~/ where the lock has tokens and the home spelled out', async () => {
    const { ctx, logs } = fakeContext({ interactive: false, flags: { dryRun: true } });
    const unit: ExecUnit = {
      ...ghCliUnit(),
      closure: { ...ghCliUnit().closure, root: '<palm>/assets/trailofbits__skills/gh-cli' },
      rendered: {
        claude: [
          {
            id: 'PreToolUse//Bash',
            command: '/home/u/.palm/assets/run.sh',
            file: '<home>/.claude/settings.json',
          },
        ],
      },
    };
    const lockFile = '/home/u/.palm/palm.lock.yaml';
    await askConsent(ctx, { operation: 'install', units: [unit], prompts: [], lockFile });
    const text = logs.join('\n');
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('~/.palm/assets/trailofbits__skills/gh-cli/');
    expect(text).toContain('~/.palm/assets/run.sh');
    expect(text).not.toMatch(/<(home|palm)>|\/home\/u\//);
  });

  it('shows a target whose command differs beyond the project-dir idiom', () => {
    const unit = teamHelperUnit();
    const cursor = unit.rendered.cursor?.map((r) => ({ ...r, command: 'node ./elsewhere.js' }));
    const text = consentText(
      {
        operation: 'install',
        units: [{ ...unit, rendered: { ...unit.rendered, cursor } }],
        prompts: [],
        lockFile: '',
      },
      PROJECT,
    );
    expect(text).toContain(
      '     stdio  node ".palm/assets/acme-kit/team-helper/server.js"   env: none\n       cursor: node ./elsewhere.js\n',
    );
  });

  it('prints control, bidi and newline characters from a source as code points', () => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    const unit = ghCliUnit();
    const evil = {
      ...unit,
      entity: { ...unit.entity, name: `x${esc}[2K` },
      commands: [{ ...unit.commands[0]!, event: 'Stop\n  2. hook fake' }],
    };
    const text = consentText(
      {
        operation: 'install',
        units: [evil],
        prompts: [{ entity: `p${rlo}`, event: 'Stop' }],
        lockFile: '',
      },
      PROJECT,
    );
    expect(text).toContain('hook x<U+001B>[2K  from');
    expect(text).toContain('Stop<U+000A>  2. hook fake');
    expect(text).toContain('p<U+202E> Stop.');
    expect(text.includes(esc) || text.includes(rlo)).toBe(false);
  });
});

describe('nonInteractiveError', () => {
  it('matches the DESIGN section 7 error for a bare install', () => {
    const units = [
      {
        ...ghCliUnit(),
        hash: 'sha256:a7cc7911f2bd0a61d9686cbc62fcfb17c8e8276fa2ea5aa0c69e646a0b23ad60',
      },
      {
        ...teamHelperUnit(),
        hash: 'sha256:75aafd9baefdaaee905cd992fe17dbe17b4fa390f7f487399d6a57f282682c79',
      },
    ];
    const e = nonInteractiveError(
      { operation: 'install', units, prompts: [], lockFile: 'palm.lock.yaml' },
      { args: ['install'] },
    );
    expect(e.code).toBe('E_UNTRUSTED_EXEC');
    const hint = (e.hint ?? '').split('\n').join('\n  ');
    expect(`x ${e.message}\n  ${hint}`).toBe(designBlock('is `E_UNTRUSTED_EXEC`'));
  });

  it('repeats the command line, keeps allow entries for other programs and drops --dry-run', () => {
    const unit = { ...ghCliUnit(), hash: `sha256:a7cc7911${'0'.repeat(56)}` };
    const args = [
      'install',
      'obra/superpowers',
      'session-start',
      '--dry-run',
      '--allow-exec',
      'mcp:x@y=sha256:1234567812345678,hook:gh-cli@trailofbits/skills=sha256:9999999999999999',
    ];
    const e = nonInteractiveError(
      { operation: 'install', units: [unit], prompts: [], lockFile: '' },
      { args },
    );
    expect(e.message).toBe('1 program needs your consent and there is no terminal');
    expect(e.hint).toBe(
      'review:  palm install obra/superpowers session-start --dry-run --review\n' +
        `then:    palm install obra/superpowers session-start --allow-exec mcp:x@y=sha256:1234567812345678,hook:gh-cli@trailofbits/skills=${unit.hash}`,
    );
  });
});

describe('askConsent', () => {
  it('v shows the scripts, then y allows every unit', async () => {
    const { ctx, consents, logs } = fakeContext({ consent: ['v', 'y'], pager: true });
    const outcome = await askConsent(ctx, exampleRequest({ read: bodies }));
    expect(outcome).toEqual({
      allowed: ['hook:gh-cli@trailofbits/skills', 'mcp:team-helper@acme-kit'],
      declined: [],
    });
    expect(consents).toHaveLength(2);
    expect(consents[0]).toEqual({ text: consentText(exampleRequest(), PROJECT), canDiff: false });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(
      '==> .palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/persist-session-id.sh  755  612 B  sha256:1b9e04c2',
    );
    expect(logs[0]).toContain('# gh-cli:plugins/gh-cli/hooks/lib/session.sh\necho hi');
  });

  it('n declines every unit it listed', async () => {
    const { ctx } = fakeContext({ consent: ['n'] });
    expect(await askConsent(ctx, exampleRequest())).toEqual({
      allowed: [],
      declined: ['hook:gh-cli@trailofbits/skills', 'mcp:team-helper@acme-kit'],
    });
  });

  it('Enter defaults to no, as the question says', async () => {
    const { ctx, consents } = fakeContext({ consent: [''] });
    const outcome = await askConsent(ctx, exampleRequest());
    expect(outcome.allowed).toEqual([]);
    expect(outcome.declined).toHaveLength(2);
    expect(consents[0]?.text).toMatch(/\[y\/N\/v=view scripts\]$/);
  });

  it('asks only about units --allow-exec does not cover, and passes the covered ones', async () => {
    const gh = ghCliUnit();
    const { ctx, consents } = fakeContext({
      consent: ['n'],
      flags: { allowExec: [{ key: gh.key, hash: gh.hash.slice(0, 15) }] },
    });
    const outcome = await askConsent(ctx, exampleRequest());
    expect(outcome).toEqual({ allowed: [gh.key], declined: ['mcp:team-helper@acme-kit'] });
    expect(consents[0]?.text.split('\n')[0]).toBe(
      'This install adds 1 program that will run on your machine.',
    );
  });

  it('asks nothing when --allow-exec covers every unit, even without a terminal (B9: the block is printed)', async () => {
    const allow = [ghCliUnit(), teamHelperUnit()].map((u) => ({ key: u.key, hash: u.hash }));
    const { ctx, consents, logs } = fakeContext({
      interactive: false,
      flags: { allowExec: allow },
    });
    expect((await askConsent(ctx, exampleRequest())).allowed).toHaveLength(2);
    expect(consents).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('info: This install adds 2 programs that will run on your machine.');
    expect(logs[0]).toMatch(
      /\nallowed by --allow-exec: hook:gh-cli@trailofbits\/skills \(sha256:[0-9a-f]{8}\), mcp:team-helper@acme-kit/,
    );
  });

  it('--allow-exec all without a terminal is a usage error', async () => {
    const { ctx } = fakeContext({ interactive: false, flags: { allowExec: 'all' } });
    await expect(askConsent(ctx, exampleRequest())).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('--allow-exec all on a terminal shows the units and allows them without asking', async () => {
    const { ctx, consents, logs } = fakeContext({ flags: { allowExec: 'all' } });
    expect((await askConsent(ctx, exampleRequest())).allowed).toHaveLength(2);
    expect(consents).toEqual([]);
    expect(logs[0]).toContain('This install adds 2 programs');
  });

  it('without a terminal shows the units, then fails with the review and --allow-exec lines', async () => {
    const { ctx, logs } = fakeContext({
      interactive: false,
      flags: { yes: true },
      argv: ['update', 'acme-kit'],
    });
    const run = askConsent(ctx, exampleRequest());
    await expect(run).rejects.toMatchObject({
      code: 'E_UNTRUSTED_EXEC',
      hint: expect.stringMatching(
        /^review: {2}palm update acme-kit --dry-run --review\nthen: {4}palm update acme-kit --allow-exec hook:gh-cli@/,
      ),
    });
    expect(logs[0]).toContain('info: This install adds 2 programs');
    expect(logs[0]).not.toContain('Allow these');
  });

  it('a dry run shows the units and asks nothing', async () => {
    const { ctx, consents, logs } = fakeContext({ interactive: false, flags: { dryRun: true } });
    expect(await askConsent(ctx, exampleRequest())).toEqual({ allowed: [], declined: [] });
    expect(consents).toEqual([]);
    expect(logs[0]).toContain('1. hook gh-cli');
  });

  it('d pages the diff against the trusted version, then asks again', async () => {
    const now = ghCliUnit();
    const before: ExecUnit = {
      ...now,
      from: { sha: '1111111aaaa' },
      closure: {
        ...now.closure,
        files: now.closure.files.map((f) =>
          f.path === 'plugins/gh-cli/hooks/lib/common.sh' ? { ...f, hash: 'sha256:old' } : f,
        ),
      },
    };
    const read = async (unit: ExecUnit, file: ClosureFile) =>
      unit === before ? 'echo old\n' : `echo ${file.path}\n`;
    const { ctx, consents, logs } = fakeContext({ consent: ['d', 'y'] });
    await askConsent(ctx, {
      operation: 'update',
      units: [now],
      prompts: [],
      lockFile: 'palm.lock.yaml',
      previous: { [now.key]: before },
      read,
    });
    expect(consents.map((c) => c.canDiff)).toEqual([true, true]);
    expect(logs[0]).toContain('changes since the trusted version (commit 1111111 → 82fe822)');
    expect(logs[0]).toContain(
      '--- a/plugins/gh-cli/hooks/lib/common.sh\n+++ b/plugins/gh-cli/hooks/lib/common.sh\n@@ -1 +1 @@\n-echo old\n+echo plugins/gh-cli/hooks/lib/common.sh',
    );
  });

  it('ignores d when there is nothing to diff', async () => {
    const { ctx, consents, logs } = fakeContext({ consent: ['d', 'n'] });
    await askConsent(ctx, exampleRequest());
    expect(consents).toHaveLength(2);
    expect(logs).toEqual([]);
  });
});

describe('viewScripts', () => {
  it('prints bodies, marks binary and unreadable files, and escapes control characters', async () => {
    const unit = ghCliUnit();
    const read = async (_u: ExecUnit, f: ClosureFile) => {
      if (f.path.endsWith('common.sh')) return 'a\u0000b';
      if (f.path.endsWith('gh.sh')) return undefined;
      if (f.path.endsWith('json.sh')) throw new Error('boom');
      return 'echo "\u001b[31mred"\r\n';
    };
    const { ctx, logs } = fakeContext();
    await viewScripts(ctx, [unit], read);
    const text = logs[0] ?? '';
    expect(text.startsWith('info: hook gh-cli from trailofbits/skills (commit 82fe822)\n')).toBe(
      true,
    );
    expect(text).toContain(
      'plugins/gh-cli/hooks/lib/common.sh  644  3.2 KB  sha256:c0000000\n(binary file, not shown)',
    );
    expect(text).toContain(
      'plugins/gh-cli/hooks/lib/gh.sh  644  3.2 KB  sha256:c1000000\n(palm could not read this file from the cache)',
    );
    expect(text).toContain(
      'plugins/gh-cli/hooks/lib/json.sh  644  3.2 KB  sha256:c2000000\n(palm could not read this file from the cache)',
    );
    expect(text).toContain('echo "<U+001B>[31mred"\n');
  });

  it('E2 V9 shows in-place scripts from the working tree, saying where they run', async () => {
    const base = ghCliUnit();
    const unit = { ...base, closure: { ...base.closure, root: 'agent-kit/hooks', inPlace: true } };
    const { ctx, logs } = fakeContext();
    await viewScripts(ctx, [unit], bodies);
    expect(logs[0]).toContain('runs in place from agent-kit/hooks; shown from the working tree');
    expect(logs[0]).toContain(`# gh-cli:${base.closure.files[0]?.path}\necho hi`);
  });
});

describe('checkoutReader', () => {
  it('reads a closure file with git at the unit commit, under the directory it was copied from', async () => {
    const unit = ghCliUnit();
    const read = checkoutReader((u) =>
      u.key === unit.key
        ? { checkoutDir: '/cache/tob/sha-82fe822', dirRel: 'plugins/gh-cli' }
        : undefined,
    );
    const file = unit.closure.files[0]!;
    expect(await read(unit, file)).toBe('echo from git\n');
    expect(git.fileAtSha).toHaveBeenCalledWith(
      '/cache/tob/sha-82fe822',
      unit.from?.sha,
      `plugins/gh-cli/${file.path}`,
    );
    expect(await read(teamHelperUnit(), file)).toBeUndefined();
  });

  it('D12 V3 reads the trusted commit from its own checkout beside the current one', async () => {
    const unit = { ...ghCliUnit(), from: { sha: 'a'.repeat(40) } };
    git.fileAtSha.mockClear();
    git.fileAtSha.mockImplementation(async (dir: string) =>
      dir.endsWith(`sha-${'a'.repeat(40)}`) ? 'old body\n' : undefined,
    );
    const read = checkoutReader(() => ({
      checkoutDir: `/cache/tob/sha-${'b'.repeat(40)}`,
      dirRel: '',
    }));
    expect(await read(unit, unit.closure.files[0]!)).toBe('old body\n');
    expect(git.fileAtSha).toHaveBeenLastCalledWith(
      `/cache/tob/sha-${'a'.repeat(40)}`,
      'a'.repeat(40),
      unit.closure.files[0]!.path,
    );
    git.fileAtSha.mockImplementation(async () => 'echo from git\n');
  });

  it('E2 reads an in-place unit from the working tree, with no commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'palm-exec-'));
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, 'hooks', 'fmt.sh'), 'gofmt -l .\n');
    const base = teamHelperUnit();
    const file: ClosureFile = { path: 'hooks/fmt.sh', mode: 0o755, size: 11, hash: 'sha256:0' };
    const unit: ExecUnit = {
      ...base,
      closure: { root: 'kit', inPlace: true, files: [file], bytes: 11, abs: dir },
    };
    expect(await checkoutReader(() => undefined)(unit, file)).toBe('gofmt -l .\n');
  });
});

describe('J11 the consent error redacts typed values', () => {
  it('J11 review: and then: repeat the command with references, never the typed value', () => {
    const typed = ['sk', 'raj', 'fake', '1234'].join('-');
    const req: ConsentRequest = {
      operation: 'install',
      units: [teamHelperUnit()],
      prompts: [],
      lockFile: 'palm.lock.yaml',
    };
    const err = nonInteractiveError(req, {
      args: [
        'install',
        'mcp',
        'brave',
        '--command',
        'npx',
        '--env',
        `BRAVE_API_KEY=${typed}`,
        '-g',
      ],
    });
    expect(err.hint).not.toContain(typed);
    expect(err.hint).toContain(`--env 'BRAVE_API_KEY=\${BRAVE_API_KEY}'`);
  });
});

describe('a request without prompt hooks', () => {
  it('has no "Also" line and no blank line pair', () => {
    const req: ConsentRequest = {
      operation: 'install',
      units: [teamHelperUnit()],
      prompts: [],
      lockFile: '',
    };
    expect(consentText(req, PROJECT)).not.toMatch(/\n\n\n/);
  });
});
