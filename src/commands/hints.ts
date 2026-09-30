/**
 * The commands palm prints for a person to paste (PLAN.md §4.9): built from what is declared
 * and installed, never from a placeholder alone, and in the scope the command ran in (`-g`).
 * Pure: `palm --help` loads this module through the grammar.
 */
import type { EntityRefSpec, Kind, Scope } from '../core/types.js';
import { redactTypedArgs } from '../secrets/typed.js';

/** `skill:tdd` for a name with a kind, else the name. */
export function formatName(n: EntityRefSpec): string {
  return n.kind ? `${n.kind}:${n.name}` : n.name;
}

/** The palm.yaml of a scope as a person reads it: `palm.yaml`, or `~/.palm/palm.yaml` under -g. */
export function manifestFile(scope: Scope | undefined): string {
  return scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
}

/** ` -g` under the global scope, else nothing. */
export function scopeFlag(scope: Scope | undefined): string {
  return scope === 'global' ? ' -g' : '';
}

/** `palm <verb> <words…>` with ` -g` under the global scope. */
export function palmLine(verb: string, words: readonly string[], scope?: Scope): string {
  return `${['palm', verb, ...words].filter(Boolean).join(' ')}${scopeFlag(scope)}`;
}

/** A line that ends with a command (`palm …` at its start or after `: ` or `| `). */
const ENDS_WITH_COMMAND = /(^\s*|: |\| )palm [a-z]/;

/** J9: `text` with ` -g` after each command line under the global scope. */
export function scoped(text: string, scope: Scope | undefined): string {
  if (scope !== 'global') return text;
  return text
    .split('\n')
    .map((l) => (ENDS_WITH_COMMAND.test(l) && !/ -g( |$)/.test(l) ? `${l} -g` : l))
    .join('\n');
}

/** A word a shell passes on as is (`#` starts a comment only at the start of a word). */
const SHELL_SAFE = /^[\w@%+=:,./-][\w@%+=:,./#-]*$/;

/** A word as it would be typed in a shell. */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Options whose value is the next word, for reading a command line back (J6', O15). */
export const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--as',
  '--targets',
  '--target',
  '--at',
  '--allow-exec',
  '--secrets',
  '--from',
  '--ref',
  '--alias',
  '--grep',
  '--layout',
  '--url',
  '--header',
  '--command',
  '--arg',
  '--env',
  '--transport',
  '--cwd',
  '--snippet',
  '--to',
  '-s',
  '--source',
  '--in',
  '--description',
]);

/** The name of an option word (`--as` for `--as=acme`), or undefined for a positional word. */
function optionName(word: string): string | undefined {
  if (!word.startsWith('-') || word === '-') return undefined;
  return word.split('=')[0];
}

/**
 * The options of a command line as typed (each with its value, in order, typed secrets
 * redacted), without its words: what a hint repeats after the words it corrects. `keep` narrows
 * them by option name.
 */
export function typedOptions(
  argv: readonly string[],
  keep: (name: string) => boolean = () => true,
): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    const name = optionName(word);
    if (name === undefined) continue;
    const takesNext = VALUE_OPTIONS.has(name) && !word.includes('=') && i + 1 < argv.length;
    if (keep(name)) kept.push(word, ...(takesNext ? [argv[i + 1] as string] : []));
    if (takesNext) i++;
  }
  return redactTypedArgs(kept);
}

/** The options that shape a source palm.yaml does not declare yet (T9, N7). */
const SOURCE_OPTIONS: ReadonlySet<string> = new Set(['--as', '--layout']);

/** `--as` and `--layout` as typed: a line that installs from the typed source repeats them. */
export function sourceOptions(argv: readonly string[]): string[] {
  return typedOptions(argv, (name) => SOURCE_OPTIONS.has(name));
}

/**
 * `palm <verb> <words…> <options…>` with every word shell-quoted and ` -g` under the global
 * scope when the options lack it: a command built from what was typed (J6', O15, N7).
 */
export function pasteLine(
  verb: string,
  words: readonly string[],
  options: readonly string[],
  scope?: Scope,
): string {
  const global = options.includes('-g') || options.includes('--global');
  const line = ['palm', verb, ...[...words, ...options].filter(Boolean).map(shellWord)].join(' ');
  return global ? line : `${line}${scopeFlag(scope)}`;
}

const FOR_EXAMPLE_COLUMN = 42;

/** `  palm install <owner/repo> tdd          for example  palm install mattpocock/skills tdd`. */
export function exampleLine(form: string, example: string): string {
  const pad = Math.max(FOR_EXAMPLE_COLUMN - form.length, 2);
  return `  ${form}${' '.repeat(pad)}for example  ${example}`;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j] ?? 0;
      row[j] = Math.min(up + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * The candidate closest to `word` (any case): edit distance at most 2, or one containing the
 * other when the shorter has at least 3 characters. Undefined when nothing is that close.
 */
export function nearest(word: string, candidates: Iterable<string>): string | undefined {
  const q = word.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const name of new Set(candidates)) {
    const n = name.toLowerCase();
    if (n === q) return name;
    const contained = Math.min(n.length, q.length) >= 3 && (n.includes(q) || q.includes(n));
    const d = contained ? 1 : distance(q, n);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

/** A declared source as the hints name it. */
export interface KnownSource {
  /** The key in palm.yaml. */
  name: string;
  alias?: string;
  /** What installs from it without palm.yaml: `owner/repo[/sub/dir]`, a URL, or `./dir`. */
  input: string;
  /** A directory source (it belongs to its own scope). */
  local?: boolean;
  /** Repository owner and name (`mattpocock`, `skills`): 0.1 aliases and bare owners match them. */
  owner?: string;
  repo?: string;
}

/** An installed entry, for a bare name that is not a source (`palm install grill`). */
interface KnownEntry {
  kind: Kind;
  name: string;
  source: string;
}

/**
 * What the grammar knows beyond the words when a command runs (install and remove read palm.yaml
 * first). Without `isDeclared` (while commander parses) a first word is kept for the command.
 */
export interface GrammarContext {
  /** True for a source name or alias palm.yaml declares. */
  isDeclared?: (word: string) => boolean;
  scope?: Scope;
  sources?: readonly KnownSource[];
  entries?: readonly KnownEntry[];
  /** `./<word>` when the word names a directory inside the project. */
  localDir?: (word: string) => string | undefined;
  /** palm 0.1 aliases from ~/.palm/config.yaml: alias → `owner/repo` or URL. */
  legacyAliases?: Readonly<Record<string, string>>;
  /** Under -g: the sources of the project palm runs in (they do not apply to -g). */
  projectSources?: readonly KnownSource[];
}

/** Repositories for examples when palm.yaml declares none; palm consults no registry. */
export const KNOWN_SOURCES: ReadonlyArray<{ repo: string; names: readonly string[] }> = [
  { repo: 'obra/superpowers', names: ['brainstorming', 'test-driven-development'] },
  { repo: 'mattpocock/skills', names: ['tdd', 'handoff'] },
];

/**
 * The source a palm 0.1 alias means: a declared source named so, the one declared source whose
 * repository or owner it is (`superpowers`, `mattpocock`), else the alias's repository in
 * ~/.palm/config.yaml. Undefined when none or several match.
 */
export function sourceFor(alias: string, ctx: GrammarContext): string | undefined {
  if (ctx.isDeclared?.(alias)) return alias;
  const lower = alias.toLowerCase();
  const declared = ctx.sources ?? [];
  const one = (list: readonly KnownSource[]) => (list.length === 1 ? list[0]?.name : undefined);
  const named = declared.find((s) => [s.name, s.alias].some((n) => n?.toLowerCase() === lower));
  const byRepo = one(declared.filter((s) => s.repo?.toLowerCase() === lower));
  const byOwner = one(declared.filter((s) => s.owner?.toLowerCase() === lower));
  const legacy = Object.entries(ctx.legacyAliases ?? {}).find(([a]) => a.toLowerCase() === lower);
  return named?.name ?? byRepo ?? byOwner ?? legacy?.[1];
}

/** The well-known repository whose owner or name is `word` (`mattpocock` → mattpocock/skills). */
export function knownRepo(word: string): string | undefined {
  const lower = word.toLowerCase();
  return KNOWN_SOURCES.find((k) => k.repo.split('/').includes(lower))?.repo;
}

/** What installs from `source` without palm.yaml (a declared key becomes its location). */
export function inputOf(source: string, ctx: GrammarContext): string {
  return ctx.sources?.find((s) => s.name === source)?.input ?? source;
}
