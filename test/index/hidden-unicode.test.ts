import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, ScanResult } from '../../src/core/types.js';
import { putFile } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

vi.mock('../../src/domain/ignore.js', async (original) => ({
  ...(await original<object>()),
  ...(await import('./contract-fakes.js')).domainIgnore,
}));

const FIXTURE = fileURLToPath(new URL('../fixtures/hidden-unicode-like', import.meta.url));

const skillMd = (name: string, body = 'Body.') =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;

function issuesOf(r: ScanResult, kind: Entity['kind'], name: string) {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name}`);
  return e.issues;
}

describe('hidden Unicode during the scan', () => {
  it('flags a bidi override (critical), tag characters (critical) and a zero-width space (warning)', async () => {
    const r = await scanSource(FIXTURE, { name: 'hu', type: 'local', path: FIXTURE });
    expect(issuesOf(r, 'skill', 'bidi-override')).toEqual([
      {
        code: 'hidden-unicode',
        severity: 'critical',
        message:
          'skills/bidi-override/SKILL.md: 1 hidden character, first U+202E RIGHT-TO-LEFT OVERRIDE at line 8',
        file: 'skills/bidi-override/SKILL.md',
      },
    ]);
    expect(issuesOf(r, 'skill', 'zero-width')).toEqual([
      {
        code: 'hidden-unicode',
        severity: 'warning',
        message:
          'skills/zero-width/SKILL.md: 1 hidden character, first U+200B ZERO WIDTH SPACE at line 8',
        file: 'skills/zero-width/SKILL.md',
      },
    ]);
    expect(issuesOf(r, 'agent', 'tagged')).toMatchObject([
      {
        severity: 'critical',
        message: expect.stringMatching(/6 hidden characters, first U\+E0049/),
      },
    ]);
    // An emoji ZWJ sequence is spelling, not hiding; the binary asset (NUL byte) is not read.
    expect(issuesOf(r, 'skill', 'clean')).toBeUndefined();
    expect(r.warnings).toEqual([
      'hidden-unicode: skill "bidi-override" (critical): skills/bidi-override/SKILL.md: 1 hidden character, first U+202E RIGHT-TO-LEFT OVERRIDE at line 8',
      'hidden-unicode: skill "zero-width" (warning): skills/zero-width/SKILL.md: 1 hidden character, first U+200B ZERO WIDTH SPACE at line 8',
      'hidden-unicode: agent "tagged" (critical): agents/tagged.md: 6 hidden characters, first U+E0049 TAG LATIN CAPITAL LETTER I at line 6',
    ]);
  });

  describe('files', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'palm-hidden-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });
    const put = (rel: string, content: string | object) => putFile(tmp, rel, content);
    const run = () => scanSource(tmp, { name: './o', type: 'local', path: tmp });

    it('checks every file of a skill, reports the worst finding and skips large and binary files', async () => {
      await put('skills/s/SKILL.md', skillMd('s'));
      await put('skills/s/references/a.md', 'soft­hyphen\n');
      await put('skills/s/scripts/run.sh', 'echo "⁦hidden⁩"\n');
      await put('skills/s/examples/deep.txt', 'x​y\n'); // ignored by the index walk, still deployed
      await writeFile(join(tmp, 'skills/s/big.md'), `${'a'.repeat(1024 * 1024)}‮`);
      await writeFile(join(tmp, 'skills/s/blob.bin'), Buffer.from([0, 0xe2, 0x80, 0xae]));
      const r = await run();
      const issues = issuesOf(r, 'skill', 's') ?? [];
      expect(issues.map((i) => [i.file, i.severity])).toEqual([
        ['skills/s/examples/deep.txt', 'warning'],
        ['skills/s/references/a.md', 'warning'],
        ['skills/s/scripts/run.sh', 'critical'],
      ]);
      expect(r.warnings).toEqual([
        'hidden-unicode: skill "s" (critical): skills/s/scripts/run.sh: 2 hidden characters, first U+2066 LEFT-TO-RIGHT ISOLATE at line 1; 2 more files',
      ]);
    });

    it('checks hook, MCP, command-skill and instruction files, and every merged hook source', async () => {
      await put('.claude-plugin/plugin.json', { name: 'p', hooks: './extra-hooks.json' });
      await put('extra-hooks.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ‮stop' }] }] },
      });
      await put('hooks/hooks.json', {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] },
      });
      await put('.mcp.json', { mcpServers: { m: { command: 'npx', args: ['x‍'] } } });
      await put('commands/go.md', 'Go⁠ now.\n');
      await put('rules/r.mdc', '---\nalwaysApply: true\n---\nclean rule\n');
      const r = await run();
      expect(issuesOf(r, 'hook', 'p')).toMatchObject([
        { file: 'extra-hooks.json', severity: 'critical' },
      ]);
      expect(issuesOf(r, 'mcp', 'm')).toMatchObject([{ file: '.mcp.json', severity: 'warning' }]);
      expect(issuesOf(r, 'skill', 'go')).toMatchObject([{ file: 'commands/go.md' }]);
      expect(issuesOf(r, 'instruction', 'r')).toBeUndefined();
      expect(issuesOf(r, 'plugin', 'p')).toBeUndefined();
      expect(r.warnings.filter((w) => w.startsWith('hidden-unicode:'))).toHaveLength(3);
    });

    it('reports a hook source merged after the first one', async () => {
      await put('.claude-plugin/plugin.json', { name: 'p', hooks: './extra-hooks.json' });
      await put('extra-hooks.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
      });
      await put('hooks/hooks.json', {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ⁧x' }] }] },
      });
      const r = await run();
      expect(issuesOf(r, 'hook', 'p')).toMatchObject([
        { file: 'hooks/hooks.json', severity: 'critical' },
      ]);
    });

    it('checks the closure a hook copies and runs, not the files it does not copy', async () => {
      await put('.claude-plugin/plugin.json', { name: 'p' });
      await put('hooks/hooks.json', {
        hooks: {
          PostToolUse: [
            { hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/scripts/fmt.sh"' }] },
          ],
        },
      });
      await put('scripts/fmt.sh', '#!/bin/sh\necho "\u202Eevil"\n');
      await put('docs/notes.md', 'not copied \u202E\n');
      await put('README.md', 'not copied \u202E\n');
      const r = await run();
      expect(issuesOf(r, 'hook', 'p')).toMatchObject([
        { file: 'scripts/fmt.sh', severity: 'critical' },
      ]);
    });

    it('a hook that names no script is checked on its own directory only', async () => {
      await put('.claude-plugin/plugin.json', { name: 'p' });
      await put('hooks/hooks.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
      });
      await put('scripts/fmt.sh', 'echo "\u202Eevil"\n');
      await put('hooks/helper.sh', 'echo "\u2067x"\n');
      const r = await run();
      expect(issuesOf(r, 'hook', 'p')).toMatchObject([
        { file: 'hooks/helper.sh', severity: 'critical' },
      ]);
    });

    it('checks the files of an MCP server closure, skipping the ones never copied', async () => {
      await put('.mcp.json', {
        mcpServers: { srv: { command: 'node', args: ['index.js'], cwd: './server' } },
      });
      await put('server/index.js', 'run("\u202E")\n');
      await put('server/SKILL.md', '---\nname: s\ndescription: d\n---\n\u202E\n');
      const r = await run();
      expect(issuesOf(r, 'mcp', 'srv')).toMatchObject([
        { file: 'server/index.js', severity: 'critical' },
      ]);
    });

    it('leaves clean sources without issues or warnings', async () => {
      await put('skills/a/SKILL.md', skillMd('a', 'Emoji 👍🏽 and ümlauts.'));
      const r = await run();
      expect(r.entities[0]).not.toHaveProperty('issues');
      expect(r.warnings).toEqual([]);
    });
  });
});
