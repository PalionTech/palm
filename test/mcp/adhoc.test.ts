import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/core/types.js';
import { parseAdhocMcp } from '../../src/mcp/adhoc.js';
import { detectSecrets } from '../../src/mcp/secrets.js';

describe('parseAdhocMcp: valid forms', () => {
  const cases: Array<{
    title: string;
    name: string;
    opts: Parameters<typeof parseAdhocMcp>[1];
    expected: McpServerConfig;
  }> = [
    {
      title: 'command after --',
      name: 'fs',
      opts: { command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'] },
      expected: {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        source: { type: 'adhoc' },
      },
    },
    {
      title: 'command without args, with env (split at first =, empty value allowed)',
      name: 'my.server_1',
      opts: { command: ['my-mcp'], env: ['API_KEY=${API_KEY}', 'OPTS=a=b=c', 'EMPTY='] },
      expected: {
        name: 'my.server_1',
        transport: 'stdio',
        command: 'my-mcp',
        env: { API_KEY: '${API_KEY}', OPTS: 'a=b=c', EMPTY: '' },
        source: { type: 'adhoc' },
      },
    },
    {
      title: 'url → http with headers',
      name: 'docs',
      opts: {
        url: 'https://example.com/mcp',
        headers: ['Authorization=Bearer ${DOCS_TOKEN}', 'X-Sig=abc=='],
      },
      expected: {
        name: 'docs',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Sig': 'abc==' },
        source: { type: 'adhoc' },
      },
    },
    {
      title: 'url with --transport sse',
      name: 'legacy',
      opts: { url: 'http://localhost:3000/sse', transport: 'sse' },
      expected: {
        name: 'legacy',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
        source: { type: 'adhoc' },
      },
    },
    {
      title: 'url with --transport streamable-http and curl-style header',
      name: 'x',
      opts: {
        url: 'https://x.dev/mcp',
        transport: 'streamable-http',
        headers: ['X-Api-Key: ${X_KEY}'],
      },
      expected: {
        name: 'x',
        transport: 'http',
        url: 'https://x.dev/mcp',
        headers: { 'X-Api-Key': '${X_KEY}' },
        source: { type: 'adhoc' },
      },
    },
    {
      title: 'command with explicit --transport stdio',
      name: 'x',
      opts: { command: ['uvx', 'mcp-server-git'], transport: 'stdio' },
      expected: {
        name: 'x',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-git'],
        source: { type: 'adhoc' },
      },
    },
  ];

  it.each(cases)('$title', ({ name, opts, expected }) => {
    expect(parseAdhocMcp(name, opts)).toEqual(expected);
  });

  it('leaves ${VAR} placeholders for detectSecrets', () => {
    const cfg = parseAdhocMcp('docs', {
      url: 'https://example.com/mcp',
      headers: ['Authorization=Bearer ${DOCS_TOKEN}'],
    });
    expect(cfg.secrets).toBeUndefined();
    expect(detectSecrets(cfg)).toEqual([
      {
        name: 'DOCS_TOKEN',
        in: 'header',
        header: 'Authorization',
        required: true,
        format: 'Bearer {value}',
      },
    ]);
  });
});

describe('parseAdhocMcp: errors', () => {
  const cases: Array<{
    title: string;
    name: string;
    opts: Parameters<typeof parseAdhocMcp>[1];
    message: RegExp;
  }> = [
    { title: 'neither command nor url', name: 'x', opts: {}, message: /needs a command or --url/ },
    {
      title: 'empty command array',
      name: 'x',
      opts: { command: [] },
      message: /needs a command or --url/,
    },
    {
      title: 'both command and url',
      name: 'x',
      opts: { command: ['a'], url: 'https://x' },
      message: /both a command and --url/,
    },
    {
      title: 'invalid name',
      name: 'bad name!',
      opts: { command: ['a'] },
      message: /Invalid MCP server name/,
    },
    { title: 'empty name', name: '', opts: { command: ['a'] }, message: /Invalid MCP server name/ },
    {
      title: 'env without =',
      name: 'x',
      opts: { command: ['a'], env: ['NOVALUE'] },
      message: /Invalid --env "NOVALUE"/,
    },
    {
      title: 'env with empty key',
      name: 'x',
      opts: { command: ['a'], env: ['=v'] },
      message: /Invalid --env "=v"/,
    },
    {
      title: 'env with invalid key',
      name: 'x',
      opts: { command: ['a'], env: ['1BAD=v'] },
      message: /Invalid --env name "1BAD"/,
    },
    {
      title: 'header without separator',
      name: 'x',
      opts: { url: 'https://x', headers: ['Authorization'] },
      message: /Invalid --header/,
    },
    {
      title: 'header with invalid name',
      name: 'x',
      opts: { url: 'https://x', headers: ['Bad Header=v'] },
      message: /Invalid --header name/,
    },
    {
      title: 'non-http url',
      name: 'x',
      opts: { url: 'ftp://x' },
      message: /expected an http\(s\) URL/,
    },
    {
      title: 'unknown transport',
      name: 'x',
      opts: { url: 'https://x', transport: 'websocket' },
      message: /Unknown MCP transport/,
    },
    {
      title: 'stdio transport with url',
      name: 'x',
      opts: { url: 'https://x', transport: 'stdio' },
      message: /requires a command/,
    },
    {
      title: 'sse transport with command',
      name: 'x',
      opts: { command: ['a'], transport: 'sse' },
      message: /requires --url/,
    },
    {
      title: 'headers with command',
      name: 'x',
      opts: { command: ['a'], headers: ['A=b'] },
      message: /--header only applies/,
    },
    {
      title: 'env with url',
      name: 'x',
      opts: { url: 'https://x', env: ['A=b'] },
      message: /--env only applies/,
    },
    { title: 'blank executable', name: 'x', opts: { command: [' '] }, message: /empty command/ },
  ];

  it.each(cases)('$title → E_USAGE', ({ name, opts, message }) => {
    expect(() => parseAdhocMcp(name, opts)).toThrow(
      expect.objectContaining({ code: 'E_USAGE', message: expect.stringMatching(message) }),
    );
  });

  it('missing command/url hint shows both forms', () => {
    try {
      parseAdhocMcp('x', {});
      expect.unreachable();
    } catch (e) {
      const hint = (e as { hint?: string }).hint ?? '';
      expect(hint).toContain('palm install mcp <name> -- <command> [args...]');
      expect(hint).toContain('palm install mcp <name> --url <url>');
    }
  });
});
