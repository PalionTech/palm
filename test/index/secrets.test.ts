/**
 * The secrets pass of the scan (DESIGN §5 "Scan issues", §8), run
 * with the real secret shapes of src/secrets/scan.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, ScanResult } from '../../src/core/types.js';
import { scanSourceWith } from '../../src/index/scanner.js';
import type { SecretScanner } from '../../src/index/secrets.js';
import { detectSecrets, redact, scanSecrets, scanText } from '../../src/secrets/scan.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = 'sk-live-0123456789abcdef';

let tmp: string;
beforeEach(async () => {
  tmp = await tempDir('palm-secrets-');
});
afterEach(async () => removeDir(tmp));

const put = (rel: string, content: string | object) => putFile(tmp, rel, content);
const run = () => scanSource(tmp, { name: './kit', type: 'local', path: tmp });

function find(r: ScanResult, kind: Entity['kind'], name: string): Entity {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name}`);
  return e;
}

describe('secrets pass', () => {
  it('redacts a literal token in an MCP env, header, arg and URL and records critical issues', async () => {
    await put('.mcp.json', {
      mcpServers: {
        docs: {
          command: 'npx',
          args: ['-y', 'docs-server', `--key=${KEY}`],
          env: { GITHUB_TOKEN: TOKEN, REGION: 'eu', API_KEY: '${API_KEY}' },
        },
        remote: {
          url: `https://example.com/mcp?token=${TOKEN}`,
          headers: { Authorization: `Bearer ${KEY}`, 'X-Team': '${TEAM}' },
        },
      },
    });
    const r = await run();
    const docs = find(r, 'mcp', 'docs');
    expect(docs.def).toMatchObject({
      mcp: {
        args: ['-y', 'docs-server', redact(`--key=${KEY}`)],
        env: { GITHUB_TOKEN: redact(TOKEN), REGION: 'eu', API_KEY: '${API_KEY}' },
        // detectSecrets runs on the redacted definition
        secrets: [{ name: 'API_KEY', in: 'env', required: true }],
      },
    });
    expect(docs.issues).toEqual([
      {
        code: 'secret-literal',
        severity: 'critical',
        message: `mcp:docs.env.GITHUB_TOKEN: literal secret (a known token prefix) ${redact(TOKEN)}`,
        file: '.mcp.json',
      },
      {
        code: 'secret-literal',
        severity: 'critical',
        message: `mcp:docs.args[2]: literal secret (a known token prefix) ${redact(`--key=${KEY}`)}`,
        file: '.mcp.json',
      },
    ]);
    const remote = find(r, 'mcp', 'remote');
    expect(remote.def).toMatchObject({
      mcp: {
        url: redact(`https://example.com/mcp?token=${TOKEN}`),
        headers: { Authorization: `Bearer ${redact(KEY)}`, 'X-Team': '${TEAM}' },
      },
    });
    expect(remote.issues?.map((i) => [i.severity, i.message.split(':')[0]])).toEqual([
      ['critical', 'mcp'],
      ['critical', 'mcp'],
    ]);
    expect(r.warnings).toEqual([
      `secret-literal: mcp "docs" (critical): ${docs.issues?.[0]?.message}; 1 more value`,
      `secret-literal: mcp "remote" (critical): ${remote.issues?.[0]?.message}; 1 more value`,
    ]);
    // The index holds no secret value.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('warns about a literal token in a closure script, naming the file and line', async () => {
    await put('.claude-plugin/plugin.json', { name: 'p' });
    await put('hooks/hooks.json', {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/notify.sh' }] }],
      },
    });
    await put('bin/notify.sh', `#!/bin/sh\ncurl -H "Authorization: token ${TOKEN}" x\n`);
    await put('bin/other.sh', `echo ${TOKEN}\n`);
    const r = await run();
    const hook = find(r, 'hook', 'p');
    expect(hook.def).toMatchObject({ hooks: { closure: { paths: ['bin/notify.sh', 'hooks'] } } });
    expect(hook.issues).toEqual([
      {
        code: 'secret-literal',
        severity: 'warning',
        message: `bin/notify.sh:2: literal secret (a known token prefix) ${redact(TOKEN)}`,
        file: 'bin/notify.sh',
      },
    ]);
    expect(r.warnings).toEqual([
      `secret-literal: hook "p" (warning): ${hook.issues?.[0]?.message}`,
    ]);
  });

  it('redacts a literal in a hook command and a Copilot hook env (critical)', async () => {
    await put('hooks/notify/hooks.json', {
      version: 1,
      hooks: {
        sessionEnd: [
          { type: 'command', bash: `./send.sh --token ${TOKEN}`, env: { SLACK: KEY, N: 1 } },
        ],
      },
    });
    await put('hooks/notify/send.sh', 'echo\n');
    const r = await run();
    const hook = find(r, 'hook', 'notify');
    expect(hook.def).toMatchObject({
      hooks: {
        dialect: 'copilot',
        raw: {
          hooks: {
            sessionEnd: [
              {
                bash: redact(`./send.sh --token ${TOKEN}`),
                env: { SLACK: redact(KEY), N: 1 },
              },
            ],
          },
        },
      },
    });
    expect(hook.issues?.map((i) => [i.severity, i.message.split(': ')[0]])).toEqual([
      ['critical', 'hook:notify#sessionEnd//-'],
      ['critical', 'hook:notify#sessionEnd//-.env.SLACK'],
    ]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('scans args as one list and redacts every argument a finding cannot be placed in', async () => {
    await put('.mcp.json', {
      mcpServers: { s: { command: 'x', args: ['--api-key', 'abc', 'b'] } },
    });
    const unplaced: SecretScanner = {
      scanText,
      redact,
      detectSecrets,
      scanSecrets: (value, where) =>
        Array.isArray(value) ? [{ where, shape: 'high-entropy', redacted: redact('abc') }] : [],
    };
    const r = await scanSourceWith(tmp, { name: './kit', type: 'local', path: tmp }, unplaced);
    expect(find(r, 'mcp', 's').def).toMatchObject({
      mcp: { args: [redact('--api-key'), redact('abc'), redact('b')] },
    });
  });

  it('leaves clean servers and hooks without issues', async () => {
    await put('.mcp.json', { mcpServers: { ok: { command: 'npx', env: { T: '${T}' } } } });
    const r = await run();
    expect(find(r, 'mcp', 'ok')).not.toHaveProperty('issues');
    expect(r.warnings).toEqual([]);
  });
});
