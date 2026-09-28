/**
 * The kubectl-style grammar `palm <verb> [kind] [names...] [flags]` (DESIGN.md §9): the verb
 * table, how the first word becomes a resource, and the `Invocation` every command action
 * hands to the dispatcher. Pure and light: `palm --help` loads this, so it imports nothing
 * but kinds and errors.
 */
import { PalmError } from '../core/errors.js';
import { parseResource, type Resource, SHORT_NAMES } from '../core/kinds.js';
import { KINDS, type Kind } from '../core/types.js';

export type Verb = 'install' | 'uninstall' | 'get' | 'describe' | 'update' | 'create' | 'search';

export interface VerbSpec {
  name: Verb;
  aliases: readonly string[];
  /** One line for the root help. */
  summary: string;
  /** Resources the verb accepts as its first word. */
  resources: readonly Resource[];
  /** The first word must be a resource (describe, create). */
  kindRequired?: boolean;
}

export const CREATABLE: readonly Kind[] = ['skill', 'agent', 'instruction', 'command'];

export const VERBS: readonly VerbSpec[] = [
  {
    name: 'install',
    aliases: ['add', 'i'],
    summary: 'install entities or register an origin',
    resources: [...KINDS, 'origin'],
  },
  {
    name: 'uninstall',
    aliases: ['remove', 'rm', 'delete'],
    summary: 'remove entities or unregister an origin',
    resources: [...KINDS, 'origin'],
  },
  {
    name: 'get',
    aliases: ['list', 'ls'],
    summary: 'list installed entities, origins, targets',
    resources: [...KINDS, 'origin', 'target', 'all'],
  },
  {
    name: 'describe',
    aliases: ['info'],
    summary: 'show one entity, origin or target',
    resources: [...KINDS, 'origin', 'target'],
    kindRequired: true,
  },
  {
    name: 'update',
    aliases: ['up'],
    summary: 'update entities or refresh origin indexes',
    resources: [...KINDS, 'origin'],
  },
  {
    name: 'create',
    aliases: ['new'],
    summary: 'create a skill, agent, instruction or command',
    resources: CREATABLE,
    kindRequired: true,
  },
  {
    name: 'search',
    aliases: [],
    summary: 'search origins and the MCP registry',
    resources: KINDS,
  },
];

export const UTILITIES = [
  'init',
  'doctor',
  'outdated',
  'why',
  'find',
  'audit',
  'config',
  'completion',
  'cache',
] as const;

/** What a command action hands to the dispatcher. */
export interface Invocation {
  /** A verb, or a utility path: `init`, `doctor`, `config get`, `cache clean`, `completion`. */
  command: string;
  resource?: Resource;
  names: string[];
  /** Command options merged with the global ones (commander `optsWithGlobals`). */
  opts: Record<string, unknown>;
  /** `palm origin import`: the spec is a marketplace file or a directory holding one. */
  marketplace?: boolean;
}

export type Dispatch = (inv: Invocation) => Promise<void>;

/** Thrown by a command to end the process with a given exit code after it has printed its own output. */
export class ExitSignal extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'ExitSignal';
    this.exitCode = exitCode;
  }
}

/** Split argv at the first `--`: everything after it is a pass-through command (ad hoc MCP servers). */
export function splitPassthrough(argv: string[]): { args: string[]; passthrough: string[] } {
  const i = argv.indexOf('--');
  if (i === -1) return { args: argv, passthrough: [] };
  return { args: argv.slice(0, i), passthrough: argv.slice(i + 1) };
}

export function usage(message: string, hint?: string): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

export function verbSpec(verb: Verb): VerbSpec {
  const spec = VERBS.find((v) => v.name === verb);
  if (!spec) throw new PalmError('E_INTERNAL', `unknown verb ${verb}`);
  return spec;
}

/** `skill (sk)`, `origin (orig)`, `all`: how a resource is listed in help and errors. */
export function resourceLabel(r: Resource): string {
  const short = SHORT_NAMES[r];
  return short && short !== r ? `${r} (${short})` : r;
}

export function plural(r: Resource): string {
  if (r === 'all') return 'all';
  return r === 'mcp' ? 'MCP servers' : `${r}s`;
}

const RESOURCE_HINTS: Partial<Record<Verb, Partial<Record<Resource, string>>>> = {
  install: {
    target: 'targets are chosen per command: palm install skill <name> --target claude,codex',
  },
  uninstall: { target: 'see what palm writes to: palm get targets' },
  describe: { all: 'list everything: palm get all' },
  update: { target: 'see what palm writes to: palm get targets' },
  search: { origin: 'list origins: palm get origins', target: 'list targets: palm get targets' },
};

function unsupported(verb: Verb, resource: Resource): PalmError {
  const spec = verbSpec(verb);
  return usage(
    `palm ${verb} does not take ${plural(resource)}`,
    RESOURCE_HINTS[verb]?.[resource] ??
      `palm ${verb} takes: ${spec.resources.map(resourceLabel).join(', ')}`,
  );
}

const MISSING_KIND_HINT: Partial<Record<Verb, string>> = {
  describe: 'palm describe skill <name>   or   palm describe origin <alias>',
  create: `palm create ${CREATABLE.join('|')} [name]`,
};

/** `search [kind] <query...>`: a leading kind word counts only when a query follows it. */
function interpretSearch(words: string[]): { resource?: Resource; names: string[] } {
  const resource = words.length > 1 ? parseResource(words[0]) : undefined;
  if (!resource) return { names: words };
  if (!verbSpec('search').resources.includes(resource)) throw unsupported('search', resource);
  return { resource, names: words.slice(1) };
}

/**
 * The first word as a resource (singular, plural or short name) and the rest as names.
 * A first word that is no resource is a name, except where the verb needs a kind.
 */
export function interpretWords(
  verb: Verb,
  words: string[],
): { resource?: Resource; names: string[] } {
  if (verb === 'search') return interpretSearch(words);
  const spec = verbSpec(verb);
  const resource = parseResource(words[0]);
  if (resource && !spec.resources.includes(resource)) throw unsupported(verb, resource);
  if (resource) return { resource, names: words.slice(1) };
  if (!spec.kindRequired) return { names: words };
  const first = words[0];
  if (first === undefined) throw usage(`name what to ${verb}`, MISSING_KIND_HINT[verb]);
  throw usage(
    `"${first}" is not something palm can ${verb}`,
    verb === 'describe'
      ? `name the kind first: palm describe skill ${first}`
      : MISSING_KIND_HINT[verb],
  );
}
