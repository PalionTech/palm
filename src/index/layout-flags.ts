/**
 * `--layout kind=glob` on the first declaration of a source (ruling K2): each value names one
 * layout key and one or more comma-separated globs (`--layout agents=people/*.md --layout
 * skills=packages/*`); repeated keys add up. The result is the source's `layout:` in palm.yaml.
 */

import { PalmError } from '../core/errors.js';
import type { LayoutDescriptor } from '../core/types.js';

type ListKey = 'skills' | 'agents' | 'commands' | 'instructions' | 'hooks' | 'mcp' | 'exclude';

const KEYS: readonly ListKey[] = [
  'skills',
  'agents',
  'commands',
  'instructions',
  'hooks',
  'mcp',
  'exclude',
];

/** Spellings people type for a key: singular forms, and harness words for instructions. */
const ALIASES: Readonly<Record<string, ListKey>> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  prompts: 'commands',
  instruction: 'instructions',
  rule: 'instructions',
  rules: 'instructions',
  hook: 'hooks',
  servers: 'mcp',
};

function keyOf(word: string): ListKey | undefined {
  const w = word.trim().toLowerCase();
  return KEYS.find((k) => k === w) ?? ALIASES[w];
}

function badValue(value: string): PalmError {
  return new PalmError(
    'E_USAGE',
    `--layout ${value}: expected kind=glob, kind one of ${KEYS.join(', ')}`,
    'for example: --layout agents=people/*.md --layout skills=packages/*',
  );
}

/** The layout descriptor `--layout` values describe; E_USAGE for a value without `kind=glob`. */
export function parseLayoutFlags(values: readonly string[]): LayoutDescriptor {
  const out: Partial<Record<ListKey, string[]>> = {};
  for (const value of values) {
    const eq = value.indexOf('=');
    const key = eq > 0 ? keyOf(value.slice(0, eq)) : undefined;
    const globs = value
      .slice(eq + 1)
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g !== '');
    if (!key || globs.length === 0) throw badValue(value);
    out[key] = [...new Set([...(out[key] ?? []), ...globs])];
  }
  return out;
}
