import { KINDS, type Kind } from './types.js';

/**
 * What a CLI verb acts on (`palm get <resource> [names...]`): an entity kind, the sources palm
 * installs from, the targets it installs into, or `all` (only `palm get all`).
 */
export type Resource = Kind | 'source' | 'target' | 'all';

export const RESOURCES: readonly Resource[] = [...KINDS, 'source', 'target', 'all'] as const;

/** kubectl-style short names (`palm get sk`, `palm describe src mattpocock/skills`). */
export const SHORT_NAMES: Readonly<Record<Resource, string | undefined>> = {
  skill: 'sk',
  agent: 'ag',
  instruction: 'ins',
  hook: 'hk',
  mcp: 'mcp',
  plugin: 'pl',
  source: 'src',
  target: 'tg',
  all: undefined,
};

/** Words that name commands and prompts: those install as skills (DESIGN.md section 1). */
const COMMAND_WORDS: readonly string[] = ['command', 'commands', 'cmd', 'prompt', 'prompts'];

const ALIASES: Record<string, Kind> = {
  skill: 'skill',
  skills: 'skill',
  sk: 'skill',
  ...Object.fromEntries(COMMAND_WORDS.map((w) => [w, 'skill' as const])),
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

/** Resource words that are not kinds. `origin` words map to `source` for one release. */
const RESOURCE_ALIASES: Record<string, Exclude<Resource, Kind>> = {
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

/**
 * A user-supplied entity kind word (singular, plural, short name or alias), any case.
 * `command(s)`, `cmd` and `prompt(s)` give `skill` (commands install as skills; the caller
 * prints the note, see `isCommandWord`). Undefined when the word is not a kind.
 */
export function parseKind(word?: string): Kind | undefined {
  if (!word) return undefined;
  return ALIASES[word.toLowerCase()];
}

/** Any resource word: an entity kind, `source(s)`/`src`, `target(s)`/`tg` or `all`. */
export function parseResource(word?: string): Resource | undefined {
  if (!word) return undefined;
  return parseKind(word) ?? RESOURCE_ALIASES[word.toLowerCase()];
}

/** True for `command`, `commands`, `cmd`, `prompt` and `prompts`: the "installs as a skill" note. */
export function isCommandWord(word?: string): boolean {
  return !!word && COMMAND_WORDS.includes(word.toLowerCase());
}

/** Every word `parseResource` maps to `resource` (for shell completion). */
export function resourceWords(resource: Resource): string[] {
  const table: Record<string, Resource> = { ...ALIASES, ...RESOURCE_ALIASES };
  return Object.keys(table).filter((w) => table[w] === resource);
}

const MANIFEST_KEYS = {
  skill: 'skills',
  agent: 'agents',
  instruction: 'instructions',
  hook: 'hooks',
  mcp: 'mcp',
  plugin: 'plugins',
} as const satisfies Record<Kind, string>;

/** The list under a source in palm.yaml that holds entries of `kind`. */
export function manifestKey(kind: Kind): (typeof MANIFEST_KEYS)[Kind] {
  return MANIFEST_KEYS[kind];
}

/** `skill` for one, `skills` for any other count; `MCP servers` for mcp. */
export function pluralize(kind: Kind, n: number): string {
  if (n === 1) return kind === 'mcp' ? 'MCP server' : kind;
  return kind === 'mcp' ? 'MCP servers' : `${kind}s`;
}
