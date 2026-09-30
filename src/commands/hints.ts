/**
 * The commands palm prints for a person to paste (PLAN.md §4.9): built from what is declared
 * and installed, never from a placeholder alone, and in the scope the command ran in (`-g`).
 * Pure: `palm --help` loads this module through the grammar.
 */
import type { EntityRefSpec, Kind, Scope } from '../core/types.js';

/** `skill:tdd` for a name with a kind, else the name. */
export function formatName(n: EntityRefSpec): string {
  return n.kind ? `${n.kind}:${n.name}` : n.name;
}

/** ` -g` under the global scope, else nothing. */
export function scopeFlag(scope: Scope | undefined): string {
  return scope === 'global' ? ' -g' : '';
}

/** `palm <verb> <words…>` with ` -g` under the global scope. */
export function palmLine(verb: string, words: readonly string[], scope?: Scope): string {
  return `${['palm', verb, ...words].filter(Boolean).join(' ')}${scopeFlag(scope)}`;
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** A word as it would be typed in a shell. */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
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
