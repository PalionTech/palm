/**
 * The command grammar (DESIGN.md §10): eight verbs, the source first for install and remove,
 * kind nouns for get and describe, and the palm 0.1 forms that still work for one release
 * (`install skill tdd@alias`, `install origin <spec>`), each printing its new form. Pure and
 * light: `palm --help` loads this module.
 */
import { PalmError } from '../core/errors.js';
import type { EntityRefSpec, Kind } from '../core/types.js';
import {
  isCommandWord,
  looksLikeSourceInput,
  parseEntityRef,
  parseKind,
  parseResource,
  type Resource,
} from './ports.js';

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
    summary: 'install from a source; bare, make the disk match palm.yaml',
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
    summary: 'verify palm.yaml, the lock and the files (read-only, for CI)',
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
    summary: 'show one entity, source or target, or what wrote a file',
    arguments: '<name or path>',
  },
  {
    name: 'create',
    aliases: ['new'],
    summary: "write a template into the project's own source and install it",
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

export interface GrammarContext {
  /** True for a source name or alias palm.yaml declares. Absent: decided later by the command. */
  isDeclared?: (word: string) => boolean;
}

/** `skill:tdd` for a name with a kind, else the name. */
export function formatName(n: EntityRefSpec): string {
  return n.kind ? `${n.kind}:${n.name}` : n.name;
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** A word as it would be typed in a shell. */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function commandLine(verb: string, source: string | undefined, names: EntityRefSpec[]): string {
  return ['palm', verb, source, ...names.map(formatName)].filter(Boolean).join(' ');
}

const parseNames = (words: string[]): EntityRefSpec[] => words.map((w) => parseEntityRef(w));

/** The kind word of the 0.1 grammar (`install skill tdd`), when more words follow it. */
function kindWord(words: string[]): Kind | undefined {
  const [first = '', second] = words;
  return second !== undefined && !first.includes(':') ? parseKind(first) : undefined;
}

// Palm 0.1 `name@alias#ref` -------------------------------------------------------------------

const TAGGED = /^([^@#]+)(?:@([^#]+))?(?:#(.+))?$/;

function aliasOf(word: string): { name: string; alias?: string; ref?: string } {
  const m = TAGGED.exec(word);
  return m ? { name: m[1] as string, alias: m[2], ref: m[3] } : { name: word };
}

/** `[kind] name@alias...`: the alias becomes the source; a `#ref` belongs to `update --to`. */
function legacyAlias(verb: 'install' | 'remove', words: string[]): InstallWords | undefined {
  const kind = kindWord(words);
  const items = (kind ? words.slice(1) : words).map(aliasOf);
  const aliases = [...new Set(items.flatMap((t) => (t.alias ? [t.alias] : [])))];
  const [alias] = aliases;
  if (!alias) return undefined;
  const names = items.map((t) => (kind ? { kind, name: t.name } : { name: t.name }));
  if (aliases.length > 1)
    throw usage(
      `${words.join(' ')} names ${aliases.length} sources; ${verb} from one source at a time`,
      commandLine(
        verb,
        alias,
        names.filter((_, i) => items[i]?.alias === alias),
      ),
    );
  const ref = items.find((t) => t.ref)?.ref;
  if (ref && verb === 'install')
    throw usage(
      'a version belongs to the source in palm.yaml, not to a name',
      `palm update ${alias} --to ${ref}`,
    );
  const form = `palm ${verb} ${words.join(' ')}`;
  return { source: alias, names, legacy: { form, replacement: commandLine(verb, alias, names) } };
}

// install ---------------------------------------------------------------------------------------

/** Examples for the "not a repository" error; palm consults no registry for a name. */
const KNOWN_SOURCES: ReadonlyArray<{ repo: string; names: readonly string[] }> = [
  { repo: 'obra/superpowers', names: ['brainstorming', 'test-driven-development'] },
  { repo: 'mattpocock/skills', names: ['tdd', 'handoff'] },
];

const FOR_EXAMPLE_COLUMN = 42;

function exampleLine(form: string, example: string): string {
  const pad = Math.max(FOR_EXAMPLE_COLUMN - form.length, 2);
  return `  ${form}${' '.repeat(pad)}for example  ${example}`;
}

function searchLine(word: string): string {
  const q = encodeURIComponent(word);
  return `Not sure which repository? https://github.com/search?q=${q}+SKILL.md&type=code`;
}

/**
 * DESIGN.md §10 and PLAN.md §4.9: the first word is no source. The hint is the command to type,
 * with an example; a word that names a well-known entity gets that entity's repository.
 */
export function notARepository(words: string[]): PalmError {
  const [word = '', ...rest] = words;
  const lower = word.toLowerCase();
  const repo = KNOWN_SOURCES.find((k) => k.repo.split('/')[1] === lower);
  const owner = KNOWN_SOURCES.find((k) => k.names.includes(lower));
  const message = `"${word}" is not a repository. palm installs from git repositories:`;
  if (owner && !repo) {
    const names = words.join(' ');
    const hint = exampleLine(
      `palm install <owner/repo> ${names}`,
      `palm install ${owner.repo} ${names}`,
    );
    return new PalmError('E_USAGE', message, hint);
  }
  const example = repo
    ? ['palm install', repo.repo, ...rest].join(' ')
    : 'palm install mattpocock/skills tdd';
  const lines = [exampleLine('palm install <owner/repo> [names...]', example), searchLine(word)];
  return new PalmError('E_USAGE', message, lines.join('\n'));
}

function isSource(word: string, ctx: GrammarContext): boolean {
  return looksLikeSourceInput(word) || Boolean(ctx.isDeclared?.(word));
}

function legacyOrigin(rest: string[]): InstallWords {
  const [spec, ...words] = rest;
  if (!spec) throw usage('name the repository to install from', 'palm install obra/superpowers');
  const names = parseNames(words);
  const replacement = commandLine('install', spec, names);
  return { source: spec, names, legacy: { form: 'palm install origin', replacement } };
}

function checkedAlias(legacy: InstallWords, ctx: GrammarContext): InstallWords {
  const alias = legacy.source ?? '';
  if (!ctx.isDeclared || ctx.isDeclared(alias)) return legacy;
  throw usage(
    `"${alias}" is not a source in palm.yaml`,
    'declare the sources your palm 0.1 project used: palm migrate',
  );
}

/** `install skill tdd`: the words after the kind word, their names narrowed to that kind. */
function withKind(kind: Kind, inner: InstallWords, words: string[]): InstallWords {
  const names = inner.names.map((n) => (n.kind ? n : { kind, name: n.name }));
  const replacement = commandLine('install', inner.source, names);
  const legacy = inner.legacy ?? { form: `palm install ${words.join(' ')}`, replacement };
  return { ...inner, names, ...(inner.source ? { legacy } : {}) };
}

/**
 * The words after `palm install` (DESIGN.md §10): nothing (sync with palm.yaml), `mcp …`, or a
 * source (a declared name or alias, `owner/repo…`, a URL, a path) followed by `[kind:]name…`.
 * With `isDeclared`, a first word that is no source is the "not a repository" error; without
 * it (while commander parses) the word is kept for the command to decide.
 */
export function interpretInstall(words: string[], ctx: GrammarContext = {}): InstallWords {
  const [first, ...rest] = words;
  if (first === undefined) return { names: [] };
  if (first === 'mcp') return { mcp: true, names: rest.map((name) => ({ name })) };
  if (first === 'origin') return legacyOrigin(rest);
  if (isSource(first, ctx)) return { source: first, names: parseNames(rest) };
  const legacy = legacyAlias('install', words);
  if (legacy) return checkedAlias(legacy, ctx);
  const kind = kindWord(words);
  if (kind) return withKind(kind, interpretInstall(rest, ctx), words);
  if (!ctx.isDeclared) return { source: first, names: parseNames(rest) };
  throw notARepository(words);
}

// remove ----------------------------------------------------------------------------------------

/**
 * `palm remove [source] <[kind:]name…>`: the first word is a source when it looks like one; a
 * declared source name the command recognises itself (it reads palm.yaml).
 */
export function interpretRemove(words: string[]): InstallWords {
  const [first, ...rest] = words;
  if (first === undefined) return { names: [] };
  if (first === 'origin')
    throw usage(
      'a source leaves palm.yaml with its last entry; remove the entries',
      `palm get --source ${rest[0] ?? 'obra/superpowers'}`,
    );
  if (looksLikeSourceInput(first)) return { source: first, names: parseNames(rest) };
  const legacy = legacyAlias('remove', words);
  if (legacy) return legacy;
  const kind = kindWord(words);
  if (!kind) return { names: parseNames(words) };
  const names = rest.map((name) => ({ kind, name }));
  const replacement = commandLine('remove', undefined, names);
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

const INSTALL_VERBS = new Set(['install', 'add', 'i']);
/** Global options that take a value, so the word after them is no command word. */
const VALUE_OPTIONS = new Set(['--allow-exec', '--secrets']);

function positionals(args: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith('-')) words.push(a);
  }
  return words;
}

/** `palm install mcp --json <file|->` names the snippet (DESIGN.md §9), not JSON output. */
function rewriteMcpJson(args: string[]): string[] {
  const [verb, first] = positionals(args);
  if (!INSTALL_VERBS.has(verb ?? '') || first !== 'mcp') return args;
  const i = args.indexOf('--json');
  const value = args[i + 1];
  if (i < 0 || value === undefined || (value !== '-' && value.startsWith('-'))) return args;
  return [...args.slice(0, i), '--mcp-json', ...args.slice(i + 1)];
}

/** Split argv at the first `--` and read `install mcp --json <file>` as the snippet flag. */
export function prepareArgv(argv: string[]): { args: string[]; passthrough: string[] } {
  const cut = argv.indexOf('--');
  const args = cut < 0 ? argv : argv.slice(0, cut);
  return { args: rewriteMcpJson(args), passthrough: cut < 0 ? [] : argv.slice(cut + 1) };
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
