/**
 * Locks the complete `scanOrigin` output (entity order, every field, warnings, detected rule) of
 * every fixture origin under test/fixtures. A scanner refactor must leave these snapshots
 * untouched; a deliberate behaviour change updates them with `vitest -u` in the same commit.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LayoutDescriptor, ScanResult } from '../../src/core/types.js';
import { scanOrigin } from '../../src/index/scan.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

const DIRS = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/** Extra layout-descriptor runs (the descriptor rule only fires with a layout). */
const LAYOUTS: Array<[string, LayoutDescriptor]> = [
  [
    'descriptor-like',
    {
      skills: ['catalog/skills/*'],
      agents: ['catalog/people/*.md', 'catalog/tests/*.md'],
      exclude: ['catalog/skills/gamma'],
    },
  ],
  ['openai-like', { skills: ['skills/.curated/*'] }],
];

/** Machine-independent form: absolute fixture paths replaced by `<fixtures>/`. */
function portable(r: ScanResult): unknown {
  return JSON.parse(JSON.stringify(r).split(FIXTURES).join('<fixtures>/'));
}

async function scan(dir: string, layout?: LayoutDescriptor): Promise<unknown> {
  const root = join(FIXTURES, dir);
  const alias = dir.replace(/-like$/, '');
  return portable(await scanOrigin(root, { alias, type: 'local', path: root, layout }));
}

describe('scanOrigin snapshot per fixture', () => {
  it.each(DIRS)('%s', async (dir) => {
    expect(await scan(dir)).toMatchSnapshot();
  });

  it.each(LAYOUTS)('%s with a layout descriptor', async (dir, layout) => {
    expect(await scan(dir, layout)).toMatchSnapshot();
  });
});
