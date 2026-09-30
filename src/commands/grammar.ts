/**
 * The command grammar (DESIGN.md §10): eight verbs, the source first for install and remove,
 * kind nouns for get and describe, and the palm 0.1 forms that still work for one release
 * (src/commands/legacy.ts), each printing its new form. Every command palm suggests is built
 * from what palm.yaml declares (src/commands/hints.ts). Pure and light: `palm --help` loads it.
 */
import { PalmError } from '../core/errors.js';
import { isCommandWord, parseKind, parseResource, type Resource } from '../core/kinds.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { EntityRefSpec, Kind } from '../core/types.js';
import { parseEntityRef } from '../domain/entity-ref.js';
import { type GrammarContext, palmLine, shellWord } from './hints.js';
import { commandLine, kindWord, legacyAlias, legacyOrigin, sourcedNames } from './legacy.js';
import { kindWordError, notASource } from './not-a-source.js';

export { formatName, type GrammarContext } from './hints.js';

export type Verb =
  | 'init'
  | 'install'
  | 'remove'
  | 'update'
  | 'check'
  | 'get'
  | 'describe'
  | 'create';

export interface VerbSpec {
  name: Verb;
  aliases: readonly string[];
  /** One line for the root help. */
  summary: string;
  /** The arguments as help shows them. */
  arguments: string;
}

export const VERBS: readonly VerbSpec[] = [
  {
    name: 'init',
    aliases: [],
    summary: 'write palm.yaml with the targets found here',
    arguments: '',
  },
  {
    name: 'install',
    aliases: ['add', 'i'],
    summary: 'install from a source; bare, sync with palm.yaml',
    arguments: '[source] [[kind:]name...]',
  },
  {
    name: 'remove',
    aliases: ['uninstall', 'rm'],
    summary: 'delete exactly what palm wrote for some entities',
    arguments: '[source] <[kind:]name...>',
  },
  {
    name: 'update',
    aliases: ['up'],
    summary: 'move sources to newer commits within their refs',
    arguments: '[sources...]',
  },
  {
    name: 'check',
    aliases: [],
    summary: 'verify palm.yaml, the lock and the files (CI gate)',
    arguments: '',
  },
  {
    name: 'get',
    aliases: ['list', 'ls'],
    summary: 'list what is installed, the sources or the targets',
    arguments: '[kind] [names...]',
  },
  {
    name: 'describe',
    aliases: ['info'],
    summary: 'show one entity, source, target or file',
    arguments: '<name or path>',
  },
  {
    name: 'create',
    aliases: ['new'],
    summary: 'write a template into your own source and install it',
    arguments: '<kind> <name>',
  },
];

/** A palm 0.1 form that still runs: printed as `i <form> is now: <replacement>`. */
export interface Legacy {
  form: string;
  replacement: string;
}

/** What a command action hands to the dispatcher. */
export interface Invocation {
  /** A verb (`install`), `install mcp`, or a utility (`migrate`, `completion`, `cache clean`). */
  command: string;
  resource?: Resource;
  source?: string;
  names: EntityRefSpec[];
  /** Command options merged with the global ones (commander `optsWithGlobals`). */
  opts: Record<string, unknown>;
  legacy?: Legacy;
  /** The positional words as typed (install and remove read them again with palm.yaml at hand). */
  words?: string[];
}

export type Dispatch = (inv: Invocation) => Promise<void>;

/** Thrown by a command to end the process with a given exit code after it printed its output. */
export class ExitSignal extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'ExitSignal';
    this.exitCode = exitCode;
  }
}

export function usage(message: string, hint?: string): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

export interface InstallWords {
  source?: string;
  names: EntityRefSpec[];
  mcp?: boolean;
  legacy?: Legacy;
}

const parseNames = (words: string[]): EntityRefSpec[] => words.map((w) => parseEntityRef(w));

// install ---------------------------------------------------------------------------------------

function isSource(word: string, ctx: GrammarContext): boolean {
  return looksLikeSourceInput(word) || Boolean(ctx.isDeclared?.(word));
}

/**
 * `install skill tdd` (palm 0.1) and a kind word where the source goes (`install rules`): with a
 * source after the kind word, the names narrowed to that kind and the new form printed; without
 * one, what the kind word means and how to find a repository (L5).
 */
function withKind(kind: Kind, words: string[], ctx: GrammarContext): InstallWords {
  const inner = words.slice(1);
  const [next] = inner;
  const sourced = next !== undefined && (isSource(next, ctx) || next === 'origin');
  if (ctx.isDeclared && !sourced) throw kindWordError(kind, words, ctx);
  const w = interpretInstall(inner, ctx);
  const names = w.names.map((n) => (n.kind ? n : { kind, name: n.name }));
  const replacement = commandLine('install', w.source, names, ctx.scope);
  const legacy = w.legacy ?? { form: `palm install ${words.join(' ')}`, replacement };
  return { ...w, names, ...(sourced ? { legacy } : {}) };
}

/**
 * The words after `palm install` (DESIGN.md §10): nothing (sync with palm.yaml), `mcp …`, or a
 * source (a declared name or alias, `owner/repo…`, a URL, a path) followed by `[kind:]name…`.
 * With `isDeclared`, a first word that is no source is the "not a repository" family of errors,
 * each with a command built from palm.yaml; without it (while commander parses) the word is
 * kept for the command to decide.
 */
export function interpretInstall(words: string[], ctx: GrammarContext = {}): InstallWords {
  const [first, ...rest] = words;
  if (first === undefined) return { names: [] };
  if (first === 'mcp') return { mcp: true, names: rest.map((name) => ({ name })) };
  if (first === 'origin') return legacyOrigin(rest, ctx);
  if (isSource(first, ctx))
    return { source: first, names: sourcedNames('install', first, rest, ctx) };
  const legacy = legacyAlias('install', words, ctx);
  if (legacy) return legacy;
  const kind = kindWord(words) ?? (rest.length ? undefined : parseKind(first));
  if (kind) return withKind(kind, words, ctx);
  if (!ctx.isDeclared) return { source: first, names: parseNames(rest) };
  throw notASource(words, ctx);
}

// remove ----------------------------------------------------------------------------------------

/**
 * `palm remove [source] <[kind:]name…>`: the first word is a source when it looks like one, or
 * when palm.yaml declares it and names follow it.
 */
export function interpretRemove(words: string[], ctx: GrammarContext = {}): InstallWords {
  const [first, ...rest] = words;
  if (first === undefined) return { names: [] };
  if (first === 'origin')
    throw usage(
      'a source leaves palm.yaml with its last entry; remove its entries',
      palmLine('get', ['sources'], ctx.scope),
    );
  const declared = rest.length > 0 && Boolean(ctx.isDeclared?.(first));
  if (declared || looksLikeSourceInput(first))
    return { source: first, names: sourcedNames('remove', first, rest, ctx) };
  const legacy = legacyAlias('remove', words, ctx);
  if (legacy) return legacy;
  const kind = kindWord(words);
  if (!kind) return { names: parseNames(words) };
  const names = rest.map((name) => ({ kind, name }));
  const replacement = commandLine('remove', undefined, names, ctx.scope);
  return { names, legacy: { form: `palm remove ${words.join(' ')}`, replacement } };
}

// get and describe ------------------------------------------------------------------------------

/** A path (`./x`, `~/x`, `a/b`) stays as typed; anything else is `[kind:]name`. */
function nameOrPath(word: string): EntityRefSpec {
  return /[/\\]/.test(word) || word.startsWith('.') || word.startsWith('~')
    ? { name: word }
    : parseEntityRef(word);
}

function legacyWord(verb: 'get' | 'describe', words: string[]): Legacy | undefined {
  const [word = '', ...rest] = words;
  const tail = rest.map((w) => ` ${w}`).join('');
  const form = `palm ${verb} ${word}${tail}`;
  const plural = verb === 'get';
  if (/^orig(in)?s?$/i.test(word))
    return { form, replacement: `palm ${verb} ${plural ? 'sources' : 'source'}${tail}` };
  if (isCommandWord(word))
    return {
      form,
      replacement: `palm ${verb} ${plural ? 'skills' : 'skill'}${tail} (commands install as skills)`,
    };
  return undefined;
}

/**
 * `get` and `describe`: a first word that is a kind (singular, plural or short), `source(s)`,
 * `target(s)` or `all` (get only) is the resource; the rest are names (or paths for describe).
 */
export function interpretWords(
  verb: 'get' | 'describe',
  words: string[],
): { resource?: Resource; names: EntityRefSpec[]; legacy?: Legacy } {
  const [first, ...rest] = words;
  const resource = parseResource(first);
  if (!resource) return { names: words.map(nameOrPath) };
  if (resource === 'all' && verb === 'describe')
    throw usage('palm describe shows one thing at a time', 'palm get all');
  const plain = resource === 'source' || resource === 'target' || resource === 'all';
  const names = rest.map((w) => (plain ? { name: w } : nameOrPath(w)));
  const legacy = legacyWord(verb, words);
  return legacy ? { resource, names, legacy } : { resource, names };
}

// argv ------------------------------------------------------------------------------------------

/** Options whose value may start with a dash (`--arg -y`). */
const DASH_VALUES = new Set(['--arg', '--env', '--header', '--command', '--description']);

/**
 * `--arg -y` as `--arg=-y`: commander would read `-y` as the global `--yes` and leave `--arg`
 * without its value.
 */
function attachDashValues(args: string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const next = args[i + 1];
    const dashed = next?.startsWith('-') && next !== '-';
    if (DASH_VALUES.has(a) && dashed) {
      joined.push(`${a}=${next}`);
      i++;
    } else joined.push(a);
  }
  return joined;
}

/** Split argv at the first `--`; attach dash values to their options. */
export function prepareArgv(argv: string[]): { args: string[]; passthrough: string[] } {
  const cut = argv.indexOf('--');
  const args = cut < 0 ? argv : argv.slice(0, cut);
  const passthrough = cut < 0 ? [] : argv.slice(cut + 1);
  return { args: attachDashValues(args), passthrough };
}

/** palm 0.1 `install mcp <name> -- <command> [args...]`: now `--command` and `--arg`. */
export function applyPassthrough(inv: Invocation, passthrough: string[]): Invocation {
  if (!passthrough.length) return inv;
  const [command, ...args] = passthrough;
  const name = inv.names[0]?.name ?? '';
  if (inv.command !== 'install mcp' || !command)
    throw usage(
      'palm reads words after -- only for palm install mcp',
      'palm install mcp docs --command npx --arg -y --arg docs-mcp',
    );
  const flags = [`--command ${shellWord(command)}`, ...args.map((a) => `--arg ${shellWord(a)}`)];
  const legacy = {
    form: `palm install mcp ${name} -- ${passthrough.map(shellWord).join(' ')}`,
    replacement: `palm install mcp ${name} ${flags.join(' ')}`,
  };
  const previous = Array.isArray(inv.opts.arg) ? (inv.opts.arg as string[]) : [];
  return { ...inv, opts: { ...inv.opts, command, arg: [...previous, ...args] }, legacy };
}
