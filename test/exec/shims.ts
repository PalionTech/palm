/**
 * Stand-ins for the API.md exports that src/exec and src/secrets consume from other areas
 * (lib, core, targets) while those areas are written in parallel. Each test mocks the module
 * with `shim(real, name)`: the real export wins whenever it exists, so after integration these
 * tests run against the real helpers and this file only fills gaps.
 */
import { createHash } from 'node:crypto';
import type { TargetId } from '../../src/core/types.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function entropyBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let bits = 0;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits;
}

function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function short(hash: string, n = 8): string {
  return hash.replace(/^sha256:/, '').slice(0, n);
}

const PROJECT_DIR: Record<TargetId, string> = {
  claude: '"$CLAUDE_PROJECT_DIR"',
  cursor: '"$CURSOR_PROJECT_DIR"',
  gemini: '"$GEMINI_PROJECT_DIR"',
  codex: '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
  copilot: '"$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
  opencode: '',
};

const nothing = async (): Promise<undefined> => undefined;

const SHIMS = {
  'lib/json': { canonicalJson },
  'lib/text': { entropyBitsPerChar },
  'lib/fs': { gitToplevel: nothing, isGitTracked: nothing },
  'core/hash': { sha256, short },
  'core/git': { fileAtSha: nothing, commitDate: nothing },
  'targets/index': { PROJECT_DIR },
};

/**
 * The module `real()` loads, with the shims of `name` where it lacks an export:
 * `vi.mock('../../src/core/hash.js', async (real) => (await import('../exec/shims.js')).shim(real, 'core/hash'))`.
 */
export async function shim(real: () => Promise<object>, name: keyof typeof SHIMS): Promise<object> {
  return { ...SHIMS[name], ...(await real()) };
}
