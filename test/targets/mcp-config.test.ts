import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/core/types.js';
import { OAUTH_NOTE, renderMcp, renderMcpEntry } from '../../src/targets/mcp-config.js';

const STDIO: McpServerConfig = {
  name: 'gh',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@x/gh'],
  env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG: 'debug' },
};
const HTTP: McpServerConfig = {
  name: 'docs',
  transport: 'http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'core' },
};

describe('renderMcp env-ref', () => {
  it('claude uses ${VAR}', () => {
    const r = renderMcp(STDIO, 'claude', 'env-ref');
    expect(r.entry).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@x/gh'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG: 'debug' } });
    expect(r.envRefs).toEqual(['GITHUB_TOKEN']);
    expect(r.notes).toEqual([]);
  });

  it('cursor and VS Code use ${env:VAR}', () => {
    expect(renderMcpEntry(STDIO, 'cursor', 'env-ref')).toEqual({ command: 'npx', args: ['-y', '@x/gh'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}', LOG: 'debug' } });
    expect(renderMcpEntry(STDIO, 'copilot', 'env-ref')).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@x/gh'],
      env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}', LOG: 'debug' },
    });
    expect(renderMcpEntry(HTTP, 'copilot', 'env-ref')).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}', 'X-Team': 'core' },
    });
  });

  it('Copilot CLI (global) uses type local and tools ["*"]', () => {
    expect(renderMcpEntry(STDIO, 'copilot', 'env-ref', {}, { scope: 'global' })).toEqual({
      type: 'local',
      command: 'npx',
      args: ['-y', '@x/gh'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG: 'debug' },
      tools: ['*'],
    });
    expect(renderMcpEntry({ name: 's', transport: 'sse', url: 'https://s' }, 'copilot', 'literal', {}, { scope: 'global' })).toEqual({
      type: 'sse',
      url: 'https://s',
      tools: ['*'],
    });
  });

  it('codex: env_vars, bearer_token_env_var, env_http_headers', () => {
    expect(renderMcp(STDIO, 'codex', 'env-ref')).toEqual({
      entry: { command: 'npx', args: ['-y', '@x/gh'], env_vars: ['GITHUB_TOKEN'], env: { LOG: 'debug' } },
      notes: [],
      envRefs: ['GITHUB_TOKEN'],
    });
    const http = renderMcp({ ...HTTP, headers: { ...HTTP.headers, 'X-Key': '${KEY}', 'X-Tmpl': 'Token ${TMPL}' } }, 'codex', 'env-ref');
    expect(http.entry).toEqual({
      url: 'https://example.com/mcp',
      bearer_token_env_var: 'DOCS_TOKEN',
      http_headers: { 'X-Team': 'core' },
      env_http_headers: { 'X-Key': 'KEY', 'X-Tmpl': 'TMPL' },
    });
    expect(http.envRefs).toEqual(['DOCS_TOKEN', 'KEY', 'TMPL']);
    expect(http.notes).toEqual(['Codex reads the complete "X-Tmpl" header value from TMPL; set TMPL to "Token ${TMPL}" with the value filled in']);
  });

  it('codex: renamed env reference is forwarded under the key name with a note', () => {
    const r = renderMcp({ ...STDIO, env: { API_KEY: '${MY_TOKEN}' } }, 'codex', 'env-ref');
    expect(r.entry).toMatchObject({ env_vars: ['API_KEY'] });
    expect(r.notes).toEqual(['Codex forwards API_KEY from your environment: export API_KEY="${MY_TOKEN}"']);
  });
});

describe('renderMcp literal', () => {
  const values = { GITHUB_TOKEN: 'ghp_1', DOCS_TOKEN: 'd0c' };
  it('substitutes values in every harness', () => {
    expect(renderMcpEntry(STDIO, 'claude', 'literal', values)).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_1' } });
    expect(renderMcpEntry(STDIO, 'cursor', 'literal', values)).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_1' } });
    expect(renderMcpEntry(HTTP, 'copilot', 'literal', values)).toMatchObject({ headers: { Authorization: 'Bearer d0c' } });
    expect(renderMcpEntry(STDIO, 'codex', 'literal', values)).toEqual({ command: 'npx', args: ['-y', '@x/gh'], env: { GITHUB_TOKEN: 'ghp_1', LOG: 'debug' } });
    expect(renderMcpEntry(HTTP, 'codex', 'literal', values)).toEqual({
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer d0c', 'X-Team': 'core' },
    });
  });

  it('missing values keep the env reference and add a note', () => {
    const r = renderMcp(STDIO, 'cursor', 'literal', {});
    expect(r.entry).toMatchObject({ env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } });
    expect(r.notes).toEqual(['no value for GITHUB_TOKEN; left as an environment reference']);
    expect(r.envRefs).toEqual(['GITHUB_TOKEN']);
    const c = renderMcp(HTTP, 'codex', 'literal', {});
    expect(c.entry).toMatchObject({ bearer_token_env_var: 'DOCS_TOKEN' });
    expect(c.notes).toEqual(['no value for DOCS_TOKEN; left as an environment reference']);
  });
});

describe('renderMcp misc', () => {
  it('HTTP without headers → OAuth note', () => {
    const r = renderMcp({ name: 'o', transport: 'http', url: 'https://o' }, 'claude', 'env-ref');
    expect(r.entry).toEqual({ type: 'http', url: 'https://o' });
    expect(r.notes).toEqual([OAUTH_NOTE]);
  });

  it('codex does not support SSE', () => {
    const r = renderMcp({ name: 's', transport: 'sse', url: 'https://s' }, 'codex', 'env-ref');
    expect(r.entry).toBeUndefined();
    expect(r.notes).toEqual(['Codex does not support SSE MCP servers; "s" skipped for codex']);
  });

  it('declared secrets without placeholders get one', () => {
    const cfg: McpServerConfig = {
      name: 'r',
      transport: 'http',
      url: 'https://r',
      secrets: [{ name: 'R_KEY', in: 'header', header: 'Authorization', format: 'Bearer {value}', required: true }],
    };
    expect(renderMcpEntry(cfg, 'claude', 'env-ref')).toEqual({ type: 'http', url: 'https://r', headers: { Authorization: 'Bearer ${R_KEY}' } });
    expect(renderMcpEntry(cfg, 'codex', 'env-ref')).toEqual({ url: 'https://r', bearer_token_env_var: 'R_KEY' });
    const env: McpServerConfig = { name: 'e', transport: 'stdio', command: 'e', secrets: [{ name: 'E_KEY', in: 'env', required: true }] };
    expect(renderMcpEntry(env, 'cursor', 'env-ref')).toEqual({ command: 'e', env: { E_KEY: '${env:E_KEY}' } });
  });

  it('accepts ${env:VAR} input tokens and codex cwd', () => {
    expect(renderMcpEntry({ name: 'x', transport: 'stdio', command: 'x', cwd: '/w', env: { A: '${env:A}' } }, 'codex', 'env-ref')).toEqual({
      command: 'x',
      cwd: '/w',
      env_vars: ['A'],
    });
  });

  it('stdio without command is a parse error', () => {
    expect(() => renderMcp({ name: 'x', transport: 'stdio' }, 'claude', 'env-ref')).toThrowError(/needs a command/);
  });
});
