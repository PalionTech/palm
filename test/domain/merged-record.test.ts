import { describe, expect, it } from 'vitest';
import type { MergedRecord as StoredMergedRecord } from '../../src/core/types.js';
import {
  type MergedRecord,
  parseMergedRecord,
  pointerOf,
  toStored,
} from '../../src/domain/merged-record.js';

const HOOK_ITEM = { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] };

/** Stored (lockfile) records palm writes, and their union form. */
const CASES: Array<[string, StoredMergedRecord, MergedRecord]> = [
  [
    'hook entry appended to /hooks/<event>',
    { file: '.claude/settings.json', pointer: '/hooks/SessionStart', value: HOOK_ITEM },
    {
      type: 'json-item',
      file: '.claude/settings.json',
      path: ['hooks', 'SessionStart'],
      value: HOOK_ITEM,
    },
  ],
  [
    'MCP server key',
    { file: '.mcp.json', pointer: '/mcpServers/gh', value: { command: 'npx' } },
    { type: 'json-key', file: '.mcp.json', path: ['mcpServers', 'gh'], value: { command: 'npx' } },
  ],
  [
    'MCP server key with escaped segments',
    { file: '.vscode/mcp.json', pointer: '/servers/io.github~1x~0y', value: { url: 'u' } },
    {
      type: 'json-key',
      file: '.vscode/mcp.json',
      path: ['servers', 'io.github/x~y'],
      value: { url: 'u' },
    },
  ],
  [
    'Codex TOML table',
    { file: '/h/.codex/config.toml', pointer: '/mcp_servers/gh', value: { command: 'npx' } },
    {
      type: 'toml-table',
      file: '/h/.codex/config.toml',
      path: ['mcp_servers', 'gh'],
      value: { command: 'npx' },
    },
  ],
  [
    'AGENTS.md block',
    { file: 'AGENTS.md', pointer: 'block:instruction:ts', value: 'Use strict.\n' },
    { type: 'md-block', file: 'AGENTS.md', id: 'instruction:ts', content: 'Use strict.\n' },
  ],
];

describe('MergedRecord', () => {
  it.each(CASES)('%s: parse and format round-trip the stored form', (_, stored, parsed) => {
    expect(parseMergedRecord(stored)).toEqual(parsed);
    expect(toStored(parsed)).toEqual(stored);
    expect(toStored(parseMergedRecord(stored))).toEqual(stored);
    expect(pointerOf(parsed)).toBe(stored.pointer);
  });

  it('a hooks pointer nested deeper than the event array is an object key', () => {
    expect(parseMergedRecord({ file: 'x.json', pointer: '/hooks/Stop/0', value: 1 }).type).toBe(
      'json-key',
    );
  });

  it.each([
    ['not a pointer', 'mcpServers/gh'],
    ['the whole file', ''],
    ['the root pointer', '/'],
    ['an empty block id', 'block:'],
  ])('rejects %s as E_INTERNAL', (_, pointer) => {
    expect(() => parseMergedRecord({ file: 'f.json', pointer, value: 1 })).toThrowError(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    );
  });
});
