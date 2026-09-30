/**
 * Stand-ins for src/commands/ports.ts: the pure helpers of core/kinds.ts, core/source-input.ts,
 * domain/entity-ref.ts and domain/ignore.ts, written from API.md and DESIGN.md §3, §5 and §10.
 * CLI tests load them with `vi.mock('../../src/commands/ports.js', () => import('./contract.js'))`
 * so they run while those modules are still on their palm 0.1 versions. With the real modules
 * in place the mock line can go and the same tests run against them.
 */
import { PalmError } from '../../src/core/errors.js';
import type { EntityRefSpec, Kind } from '../../src/core/types.js';

export type Resource = Kind | 'source' | 'target' | 'all';

const KIND_WORDS: Readonly<Record<string, Kind>> = {
  skill: 'skill',
  skills: 'skill',
  sk: 'skill',
  command: 'skill',
  commands: 'skill',
  cmd: 'skill',
  prompt: 'skill',
  prompts: 'skill',
  agent: 'agent',
  agents: 'agent',
  ag: 'agent',
  instruction: 'instruction',
  instructions: 'instruction',
  ins: 'instruction',
  hook: 'hook',
  hooks: 'hook',
  hk: 'hook',
  mcp: 'mcp',
  mcps: 'mcp',
  plugin: 'plugin',
  plugins: 'plugin',
  pl: 'plugin',
};

const RESOURCE_WORDS: Readonly<Record<string, Exclude<Resource, Kind>>> = {
  source: 'source',
  sources: 'source',
  src: 'source',
  origin: 'source',
  origins: 'source',
  orig: 'source',
  target: 'target',
  targets: 'target',
  tg: 'target',
  all: 'all',
};

export function parseKind(word?: string): Kind | undefined {
  return word ? KIND_WORDS[word.toLowerCase()] : undefined;
}

export function parseResource(word?: string): Resource | undefined {
  if (!word) return undefined;
  return parseKind(word) ?? RESOURCE_WORDS[word.toLowerCase()];
}

export function resourceWords(resource: Resource): string[] {
  const table: Record<string, Resource> = { ...KIND_WORDS, ...RESOURCE_WORDS };
  return Object.keys(table).filter((w) => table[w] === resource);
}

export function pluralize(kind: Kind, n: number): string {
  if (n === 1) return kind;
  return kind === 'mcp' ? 'MCP servers' : `${kind}s`;
}

export function isCommandWord(word?: string): boolean {
  return /^(command|commands|cmd|prompt|prompts)$/i.test(word ?? '');
}

/** owner/repo[/dir][#ref], a URL, `github:`, scp-like `user@host:path`, or a path. */
export function looksLikeSourceInput(word: string): boolean {
  const w = word.trim();
  if (/^(https?|ssh|git|file):\/\//i.test(w) || /^github:/i.test(w)) return true;
  if (/^[\w.-]+@[\w.-]+:\S/.test(w)) return true;
  if (w === '.' || w === '..' || w === '~' || /^(\.{1,2}|~)?\//.test(w)) return true;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^#\s]*)?(#\S+)?$/.test(w);
}

export function parseEntityRef(text: string): EntityRefSpec {
  if (/[@#]/.test(text))
    throw new PalmError(
      'E_USAGE',
      `"${text}" is the palm 0.1 form`,
      'name the source first: palm install mattpocock/skills tdd',
    );
  const i = text.indexOf(':');
  if (i < 0) return { name: text };
  const kind = parseKind(text.slice(0, i));
  if (!kind)
    throw new PalmError('E_USAGE', `"${text.slice(0, i)}" is not a kind`, 'palm get skill:tdd');
  return { kind, name: text.slice(i + 1) };
}

export const PLUGIN_ROOT_TOKENS =
  /\$\{?(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath)(?::?-[^}]*)?\}?/;
