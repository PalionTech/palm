/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on hooks and MCP servers, index
 * side: one test per ruling id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, Source } from '../../src/core/types.js';
import { headerVariable } from '../../src/domain/secret-refs.js';
import { fillInHeaders } from '../../src/index/mcp.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

let tmp: string;
beforeEach(async () => {
  tmp = await tempDir('palm-rulings-v3-hooks-');
});
afterEach(async () => removeDir(tmp));

const run = (extra: Partial<Source> = {}) =>
  scanSource(tmp, { name: './kit', type: 'local', path: tmp, ...extra });

const context7 = (authorization: string) => ({
  mcpServers: {
    context7: { url: 'https://mcp.context7.com/mcp', headers: { Authorization: authorization } },
  },
});

function mcpOf(entities: Entity[], name: string) {
  const e = entities.find((x) => x.kind === 'mcp' && x.name === name);
  if (e?.def.kind !== 'mcp') throw new Error(`no mcp ${name}`);
  return e.def.mcp;
}

describe('Q8 a placeholder in a source’s header becomes an optional reference', () => {
  it('Q8 Bearer YOUR_API_KEY is written as Bearer ${CONTEXT7_TOKEN:-}, optional, and the note says so', async () => {
    await putFile(tmp, '.mcp.json', context7('Bearer YOUR_API_KEY'));
    const r = await run();
    const mcp = mcpOf(r.entities, 'context7');
    expect(mcp.headers).toEqual({ Authorization: 'Bearer ${CONTEXT7_TOKEN:-}' });
    expect(mcp.secrets).toEqual([
      expect.objectContaining({ name: 'CONTEXT7_TOKEN', in: 'header', required: false }),
    ]);
    expect(r.warnings).toContain(
      'mcp context7: headers.Authorization held the placeholder YOUR_API_KEY; written as Bearer ${CONTEXT7_TOKEN:-} (optional: empty until you export CONTEXT7_TOKEN)',
    );
  });

  it('Q8 a header with a real reference or a plain value stays as written', () => {
    const cfg = {
      name: 'docs',
      transport: 'http' as const,
      url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Client': 'palm' },
    };
    expect(fillInHeaders(cfg)).toEqual({ cfg, filled: [] });
  });
});

describe('Q9 one variable name for a header, placeholder or key', () => {
  it('Q9 the placeholder path names the header variable the way a literal key is named', () => {
    const cfg = {
      name: 'context7',
      transport: 'http' as const,
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer <your-api-key>', 'x-api-key': 'YOUR_KEY' },
    };
    const { filled } = fillInHeaders(cfg);
    expect(filled.map((f) => f.variable)).toEqual([
      headerVariable('context7', 'Authorization'),
      headerVariable('context7', 'x-api-key'),
    ]);
    expect(filled.map((f) => f.variable)).toEqual(['CONTEXT7_TOKEN', 'CONTEXT7_API_KEY']);
  });
});
