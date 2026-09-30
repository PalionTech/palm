/** `palm install mcp` (DESIGN.md §9): by flags, or every server of a README snippet. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAdhocMcp } from '../../src/commands/adhoc.js';
import type { McpRequest, McpServerConfig } from '../../src/core/types.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { fakeEngine, fakeScope, lockEntry, outcome, palm } from './fakes.js';

vi.mock('../../src/commands/ports.js', () => import('./contract.js'));

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const SNIPPET = {
  mcpServers: {
    context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  },
};

/** API semantics of src/index/mcp.ts `parseMcpJson` for the wrapped form. */
function parseMcpJson(json: unknown): McpServerConfig[] {
  const servers = (json as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
  return Object.entries(servers).map(([name, s]) => ({
    name,
    transport: s.url ? 'http' : 'stdio',
    ...(s as object),
  })) as McpServerConfig[];
}

function mcpEngine() {
  return fakeEngine({
    scopes: [fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [lockEntry({ kind: 'skill', name: 'x', source: 's' })] })],
    parseMcpJson,
    installMcp: async (_ctx, reqs) => ({
      outcomes: reqs.map((r) =>
        outcome(
          lockEntry({
            kind: 'mcp',
            name: r.config.name,
            source: 'manifest',
            merged: [{ file: '.mcp.json', at: '/mcpServers', id: 'palm:mcp:x:0', key: r.config.name }],
          }),
        ),
      ),
      failures: [],
      warnings: [],
    }),
  });
}

const requests = (deps: ReturnType<typeof fakeEngine>) =>
  deps.calls.installMcp?.[0]?.[0] as McpRequest[];

describe('palm install mcp --json', () => {
  it('reads the snippet from stdin with -', async () => {
    const deps = mcpEngine();
    const stdin = Readable.from([JSON.stringify(SNIPPET)]);
    const r = await palm(sb, ['install', 'mcp', '--json', '-'], { deps, stdin });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(requests(deps).map((q) => q.config.name)).toEqual(['context7', 'docs']);
    expect(requests(deps)[0]?.config).toMatchObject({
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      origin: { type: 'snippet' },
    });
    expect(r.stdout).toBe(
      ['+ mcp  context7   .mcp.json   merged', '+ mcp  docs       .mcp.json   merged', '2 installed.', ''].join('\n'),
    );
  });

  it('reads a file, and one name picks (or renames) a server', async () => {
    const file = join(sb.project, 'server.json');
    await writeFile(file, JSON.stringify(SNIPPET));
    const deps = mcpEngine();
    await palm(sb, ['install', 'mcp', 'docs', '--json', 'server.json'], { deps });
    expect(requests(deps).map((q) => q.config.name)).toEqual(['docs']);
    const one = mcpEngine();
    const stdin = Readable.from([JSON.stringify({ mcpServers: { x: { command: 'uvx', args: ['srv'] } } })]);
    await palm(sb, ['install', 'mcp', 'mine', '--json', '-'], { deps: one, stdin });
    expect(requests(one)[0]?.config).toMatchObject({ name: 'mine', command: 'uvx' });
  });

  it('refuses text that is not JSON, with the fix', async () => {
    const stdin = Readable.from(['{ "mcpServers": ']);
    const r = await palm(sb, ['install', 'mcp', '--json', '-'], { deps: mcpEngine(), stdin });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^x the snippet on stdin is not JSON: /);
    expect(r.stderr).toContain('paste the { "mcpServers": { ... } } block from the server README');
  });

  it('names a server the snippet lacks', async () => {
    const stdin = Readable.from([JSON.stringify(SNIPPET)]);
    const r = await palm(sb, ['install', 'mcp', 'nope', 'docs', '--json', '-'], { deps: mcpEngine(), stdin });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('x the snippet has no server "nope" (it has context7, docs)');
  });

  it('does not mix --json with server flags', async () => {
    const r = await palm(sb, ['install', 'mcp', '--json', '-', '--url', 'https://x.dev']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--json takes the whole server from the snippet');
  });
});

describe('palm install mcp <name> by flags', () => {
  it('a remote server with a header', async () => {
    const deps = mcpEngine();
    const argv = ['install', 'mcp', 'docs', '--url', 'https://example.com/mcp', '--header', 'Authorization=Bearer ${DOCS_TOKEN}'];
    const r = await palm(sb, argv, { deps });
    expect(r.code).toBe(0);
    expect(requests(deps)).toEqual([
      {
        config: {
          name: 'docs',
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
          origin: { type: 'flags' },
        },
      },
    ]);
  });

  it('a stdio server with --command, --arg -y and --env', async () => {
    const deps = mcpEngine();
    const argv = ['install', 'mcp', 'xcodebuild', '--command', 'npx', '--arg', '-y', '--arg', 'xcodebuildmcp@latest', '--env', 'KEY=${KEY}', '--targets', 'claude'];
    await palm(sb, argv, { deps });
    expect(requests(deps)).toEqual([
      {
        config: {
          name: 'xcodebuild',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'xcodebuildmcp@latest'],
          env: { KEY: '${KEY}' },
          origin: { type: 'flags' },
        },
        targets: ['claude'],
      },
    ]);
  });

  it('the palm 0.1 form after -- prints the new form and runs it', async () => {
    const deps = mcpEngine();
    const r = await palm(sb, ['install', 'mcp', 'fs', '--', 'npx', '-y', 'server-fs'], { deps });
    expect(r.stdout.split('\n')[0]).toBe(
      'i palm install mcp fs -- npx -y server-fs is now: palm install mcp fs --command npx --arg -y --arg server-fs',
    );
    expect(requests(deps)[0]?.config).toMatchObject({ command: 'npx', args: ['-y', 'server-fs'] });
  });

  it('needs a name and a --url or --command', async () => {
    expect((await palm(sb, ['install', 'mcp', '--url', 'https://x.dev'])).stderr).toBe(
      'x name the MCP server\n  palm install mcp docs --url https://example.com/mcp\n',
    );
    const none = await palm(sb, ['install', 'mcp', 'docs']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('x docs needs --url (a remote server) or --command (a local one)');
  });
});

describe('parseAdhocMcp', () => {
  it.each([
    [{ url: 'ftp://x' }, '--url ftp://x is not an http(s) URL'],
    [{ command: 'npx', url: 'https://x.dev' }, 'give docs either --command or --url, not both'],
    [{ command: 'npx', headers: ['A=1'] }, '--header belongs to --url servers'],
    [{ url: 'https://x.dev', env: ['A=1'] }, '--env, --arg and --cwd belong to --command servers'],
    [{ command: 'npx', env: ['NOPE'] }, '--env "NOPE" is not KEY=VALUE'],
    [{ command: 'npx', env: ['1A=x'] }, '--env name "1A" is not valid'],
    [{ command: 'npx', transport: 'http' }, '--transport http needs --url; a --command server uses stdio'],
    [{ url: 'https://x.dev', transport: 'carrier-pigeon' }, '--transport carrier-pigeon is not stdio, http or sse'],
  ])('%j is a usage error', (opts, message) => {
    expect(() => parseAdhocMcp('docs', opts)).toThrow(message);
  });

  it('accepts curl-style headers and the sse transport', () => {
    expect(
      parseAdhocMcp('docs', { url: 'https://x.dev/sse', headers: ['X-Key: abc'], transport: 'sse' }),
    ).toEqual({
      name: 'docs',
      transport: 'sse',
      url: 'https://x.dev/sse',
      headers: { 'X-Key': 'abc' },
      origin: { type: 'flags' },
    });
  });

  it('refuses a name that is not one path segment', () => {
    expect(() => parseAdhocMcp('../x', { command: 'npx' })).toThrow(/is not a server name/);
  });
});
