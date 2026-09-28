import { KINDS, type Kind } from './types.js';

/**
 * What a CLI verb acts on (`palm <verb> <resource> [names...]`): an entity kind, the origins
 * palm installs from, the targets it installs into, or `all` (only `palm get all`).
 */
type ResourceKind = Kind | 'origin' | 'target';
export type Resource = ResourceKind | 'all';

export const RESOURCES: readonly Resource[] = [...KINDS, 'origin', 'target', 'all'] as const;

/** kubectl-style short names (`palm get sk`, `palm describe orig mattpocock`). */
export const SHORT_NAMES: Readonly<Record<Resource, string | undefined>> = {
  skill: 'sk',
  agent: 'ag',
  instruction: 'ins',
  command: 'cmd',
  hook: 'hk',
  mcp: 'mcp',
  plugin: 'pl',
  origin: 'orig',
  target: 'tg',
  all: undefined,
};

const ALIASES: Record<string, Kind> = {
  skill: 'skill',
  skills: 'skill',
  sk: 'skill',
  agent: 'agent',
  agents: 'agent',
  ag: 'agent',
  subagent: 'agent',
  subagents: 'agent',
  instruction: 'instruction',
  instructions: 'instruction',
  ins: 'instruction',
  rule: 'instruction',
  rules: 'instruction',
  command: 'command',
  commands: 'command',
  cmd: 'command',
  prompt: 'command',
  prompts: 'command',
  hook: 'hook',
  hooks: 'hook',
  hk: 'hook',
  mcp: 'mcp',
  mcps: 'mcp',
  'mcp-server': 'mcp',
  'mcp-servers': 'mcp',
  server: 'mcp',
  servers: 'mcp',
  plugin: 'plugin',
  plugins: 'plugin',
  pl: 'plugin',
  bundle: 'plugin',
  bundles: 'plugin',
};

const RESOURCE_ALIASES: Record<string, Exclude<Resource, Kind>> = {
  origin: 'origin',
  origins: 'origin',
  orig: 'origin',
  target: 'target',
  targets: 'target',
  tg: 'target',
  all: 'all',
};

/**
 * Parse a user-supplied entity kind word (singular, plural, short name or alias).
 * Returns undefined when it is not an entity kind (`origin` and `target` are not).
 */
export function parseKind(word: string | undefined): Kind | undefined {
  if (!word) return undefined;
  return ALIASES[word.toLowerCase()];
}

/** Parse any resource word: an entity kind, `origin(s)`/`orig`, `target(s)`/`tg` or `all`. */
export function parseResource(word: string | undefined): Resource | undefined {
  if (!word) return undefined;
  return parseKind(word) ?? RESOURCE_ALIASES[word.toLowerCase()];
}

/** Every word `parseResource` maps to `resource` (for shell completion). */
export function resourceWords(resource: Resource): string[] {
  const table: Record<string, Resource> = { ...ALIASES, ...RESOURCE_ALIASES };
  return Object.keys(table).filter((w) => table[w] === resource);
}

/** Manifest section name for a kind. */
export function manifestKey(
  kind: Kind,
): 'skills' | 'agents' | 'instructions' | 'commands' | 'hooks' | 'mcp' | 'plugins' {
  switch (kind) {
    case 'skill':
      return 'skills';
    case 'agent':
      return 'agents';
    case 'instruction':
      return 'instructions';
    case 'command':
      return 'commands';
    case 'hook':
      return 'hooks';
    case 'mcp':
      return 'mcp';
    case 'plugin':
      return 'plugins';
  }
}

export function pluralize(kind: Kind, n: number): string {
  if (n === 1) return kind;
  return kind === 'mcp' ? 'MCP servers' : `${kind}s`;
}
