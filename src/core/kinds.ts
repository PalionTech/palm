import { KINDS, type Kind } from './types.js';

const ALIASES: Record<string, Kind> = {
  skill: 'skill',
  skills: 'skill',
  agent: 'agent',
  agents: 'agent',
  subagent: 'agent',
  subagents: 'agent',
  instruction: 'instruction',
  instructions: 'instruction',
  rule: 'instruction',
  rules: 'instruction',
  command: 'command',
  commands: 'command',
  prompt: 'command',
  prompts: 'command',
  hook: 'hook',
  hooks: 'hook',
  mcp: 'mcp',
  mcps: 'mcp',
  'mcp-server': 'mcp',
  'mcp-servers': 'mcp',
  server: 'mcp',
  servers: 'mcp',
  plugin: 'plugin',
  plugins: 'plugin',
  bundle: 'plugin',
  bundles: 'plugin',
};

/** Parse a user-supplied kind word (singular, plural or alias). Returns undefined when it is not a kind. */
export function parseKind(word: string | undefined): Kind | undefined {
  if (!word) return undefined;
  return ALIASES[word.toLowerCase()];
}

export function isKind(word: string): word is Kind {
  return (KINDS as readonly string[]).includes(word);
}

/** Manifest section name for a kind. */
export function manifestKey(kind: Kind): 'skills' | 'agents' | 'instructions' | 'commands' | 'hooks' | 'mcp' | 'plugins' {
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
