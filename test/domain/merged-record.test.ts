import { describe, expect, it } from 'vitest';
import type { RenderedFragment } from '../../src/core/types.js';
import { parseMergedRecord, pointerOf, toLockMerged } from '../../src/domain/merged-record.js';

const frag = (
  f: Partial<RenderedFragment> & Pick<RenderedFragment, 'file' | 'at'>,
): RenderedFragment => ({
  id: 'palm:x:y:0',
  key: 'k',
  value: {},
  ...f,
});

describe('parseMergedRecord', () => {
  it('maps pointers and files to the four record types, keeping id and key', () => {
    expect(
      parseMergedRecord(frag({ file: '.claude/settings.json', at: '/hooks/Stop', value: 1 })),
    ).toEqual({
      type: 'json-item',
      file: '.claude/settings.json',
      path: ['hooks', 'Stop'],
      id: 'palm:x:y:0',
      key: 'k',
      value: 1,
    });
    expect(parseMergedRecord(frag({ file: 'opencode.json', at: '/instructions' })).type).toBe(
      'json-item',
    );
    expect(parseMergedRecord(frag({ file: '.mcp.json', at: '/mcpServers/docs' }))).toMatchObject({
      type: 'json-key',
      path: ['mcpServers', 'docs'],
    });
    expect(
      parseMergedRecord(frag({ file: '.codex/config.toml', at: '/mcp_servers/docs' })).type,
    ).toBe('toml-table');
    expect(
      parseMergedRecord(
        frag({
          file: 'AGENTS.md',
          at: 'block:instruction:db',
          key: 'instruction:db',
          value: 'text',
        }),
      ),
    ).toEqual({
      type: 'md-block',
      file: 'AGENTS.md',
      id: 'palm:x:y:0',
      key: 'instruction:db',
      content: 'text',
    });
  });

  it('refuses the root pointer, an empty block id and malformed pointers with E_INTERNAL', () => {
    for (const at of ['', '/', 'block:', 'hooks/Stop'])
      expect(() => parseMergedRecord(frag({ file: 'f.json', at })), at).toThrowError(
        expect.objectContaining({ code: 'E_INTERNAL' }),
      );
  });

  it('toLockMerged drops the value and restores the pointer', () => {
    for (const at of ['/hooks/Pre~1Tool', '/mcpServers/a~0b', 'block:k']) {
      const rec = parseMergedRecord(
        frag({ file: 'f.json', at, key: at === 'block:k' ? 'k' : 'x' }),
      );
      expect(pointerOf(rec)).toBe(at);
      expect(toLockMerged(rec)).toEqual({
        file: 'f.json',
        at,
        id: 'palm:x:y:0',
        key: at === 'block:k' ? 'k' : 'x',
      });
    }
  });
});
