/**
 * `palm install <word>` where the word is no source (DESIGN.md §10, PLAN.md §4.9). The error's
 * hint is the command to type, looked up in what palm.yaml declares and installs before any
 * example: a project source under -g, an installed entry, a directory here, a declared source
 * the word nearly names, a kind word; else the fixed examples and a GitHub search. Pure.
 */
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import type { Kind } from '../core/types.js';
import {
  exampleLine,
  type GrammarContext,
  KNOWN_SOURCES,
  type KnownSource,
  nearest,
  palmLine,
} from './hints.js';

function usage(message: string, hint: string): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

const REPOSITORY = 'palm installs from git repositories:';

/** A GitHub code search for `terms` (each encoded, joined with `+`). */
function searchLine(terms: readonly string[]): string {
  const q = terms.map(encodeURIComponent).join('+');
  return `Not sure which repository? https://github.com/search?q=${q}&type=code`;
}

const named = (word: string) => (s: KnownSource) =>
  [s.name, s.alias].some((n) => n?.toLowerCase() === word.toLowerCase());

/** K15: under -g, a word that names a source of this project. */
function projectSource(words: string[], ctx: GrammarContext): PalmError | undefined {
  const [word = '', ...rest] = words;
  const s = ctx.scope === 'global' ? ctx.projectSources?.find(named(word)) : undefined;
  if (!s) return undefined;
  const message = `"${word}" is a source of this project; -g uses the sources in ~/.palm/palm.yaml only`;
  if (s.input.startsWith('.')) return usage(message, 'list those: palm get sources -g');
  const line = palmLine('install', [s.input, ...rest], 'global');
  return usage(message, `install it for yourself from its repository: ${line}`);
}

/** B17: a word that is an entry palm installed (`palm install grill`). */
function installedEntry(words: string[], ctx: GrammarContext, kind?: Kind): PalmError | undefined {
  const [word = ''] = words;
  const lower = word.toLowerCase();
  const hit = ctx.entries?.find(
    (e) => e.name.toLowerCase() === lower && (!kind || e.kind === kind) && e.source !== 'manifest',
  );
  if (!hit) return undefined;
  const names = kind ? words.map((w) => `${kind}:${w}`) : words;
  return usage(
    `"${word}" is not a repository; it is ${hit.kind} ${hit.name} from ${hit.source}:`,
    `  ${palmLine('install', [hit.source, ...names], ctx.scope)}`,
  );
}

/** E15: a word that names a directory in the project (`.agents-kit` for `./.agents-kit`). */
function localDirectory(words: string[], ctx: GrammarContext): PalmError | undefined {
  const [word = '', ...rest] = words;
  const dir = ctx.localDir?.(word);
  if (!dir) return undefined;
  return usage(
    `"${word}" is not a repository; a directory is a source when written as a path:`,
    `  ${palmLine('install', [dir, ...rest], ctx.scope)}`,
  );
}

/** L6: the declared source whose owner or repository the word is, or whose name it nearly is. */
function nearSource(words: string[], ctx: GrammarContext): PalmError | undefined {
  const [word = '', ...rest] = words;
  const declared = ctx.sources ?? [];
  const lower = word.toLowerCase();
  const byPart = declared.filter((s) => [s.owner, s.repo].some((p) => p?.toLowerCase() === lower));
  const handles = declared.flatMap((s) => [s.name, ...(s.alias ? [s.alias] : [])]);
  const near = byPart.length === 1 ? byPart[0]?.name : nearest(word, handles);
  const hit = declared.find((s) => s.name === near || s.alias === near);
  if (!hit) return undefined;
  return usage(
    `"${word}" is not a repository; did you mean ${hit.name}?`,
    `  ${palmLine('install', [hit.name, ...rest], ctx.scope)}`,
  );
}

/** A well-known repository's name (`superpowers`) or one of its entities (`tdd`). */
function wellKnown(word: string): { repo: string; isRepo: boolean } | undefined {
  const lower = word.toLowerCase();
  const repo = KNOWN_SOURCES.find((k) => k.repo.split('/')[1] === lower);
  if (repo) return { repo: repo.repo, isRepo: true };
  const owner = KNOWN_SOURCES.find((k) => k.names.includes(lower));
  return owner ? { repo: owner.repo, isRepo: false } : undefined;
}

/** The example after the form line: a declared source, else a well-known one. */
function exampleFor(words: string[], ctx: GrammarContext): string {
  const [word = '', ...rest] = words;
  const declared = ctx.sources?.[0];
  if (declared) return palmLine('install', [declared.name, ...words], ctx.scope);
  const known = wellKnown(word);
  if (known?.isRepo) return palmLine('install', [known.repo, ...rest], ctx.scope);
  if (known) return palmLine('install', [known.repo, ...words], ctx.scope);
  return palmLine('install', ['mattpocock/skills', 'tdd'], ctx.scope);
}

/** The fixed answer (Nora's first command, PLAN.md §4.9), with examples from palm.yaml when it declares sources. */
function notARepository(words: string[], ctx: GrammarContext): PalmError {
  const [word = ''] = words;
  const message = `"${word}" is not a repository. ${REPOSITORY}`;
  const known = wellKnown(word);
  if (known && !known.isRepo && !ctx.sources?.length) {
    const names = words.join(' ');
    const example = palmLine('install', [known.repo, names], ctx.scope);
    return usage(message, exampleLine(`palm install <owner/repo> ${names}`, example));
  }
  const form = exampleLine('palm install <owner/repo> [names...]', exampleFor(words, ctx));
  return usage(message, [form, searchLine([word, 'SKILL.md'])].join('\n'));
}

/** The first word of `palm install` is none of the source forms and palm.yaml does not declare it. */
export function notASource(words: string[], ctx: GrammarContext): PalmError {
  return (
    projectSource(words, ctx) ??
    installedEntry(words, ctx) ??
    localDirectory(words, ctx) ??
    nearSource(words, ctx) ??
    notARepository(words, ctx)
  );
}

/** `install skill tdd`: what the names say beats what the kind word says, when palm knows them. */
function namedAfterKind(kind: Kind, names: string[], ctx: GrammarContext): PalmError | undefined {
  const [first = ''] = names;
  return (
    projectSource(names, ctx) ??
    installedEntry(names, ctx, kind) ??
    localDirectory(names, ctx) ??
    nearSource(names, ctx) ??
    (wellKnown(first) ? notARepository(names, ctx) : undefined)
  );
}

/** L5: the code search that finds repositories holding a kind. */
const KIND_SEARCH: Readonly<Record<Kind, readonly string[]>> = {
  skill: ['SKILL.md'],
  agent: ['path:.claude/agents'],
  instruction: ['extension:mdc'],
  hook: ['filename:hooks.json'],
  mcp: ['mcpServers'],
  plugin: ['filename:plugin.json'],
};

/**
 * L5: a kind word where the source goes (`palm install rules`, `palm install subagent reviewer`):
 * what palm calls it, the command form with an example, and a search that fits the kind. An MCP
 * server comes from its README instead.
 */
export function kindWordError(kind: Kind, words: string[], ctx: GrammarContext): PalmError {
  const [word = '', ...names] = words;
  const specific = names.length ? namedAfterKind(kind, names, ctx) : undefined;
  if (specific) return specific;
  const what = pluralize(kind, 2);
  if (kind === 'mcp')
    return usage(
      `"${word}" is a kind (${what}), not a repository. An MCP server comes from its README; paste its mcpServers block:`,
      `  pbpaste | ${palmLine('install', ['mcp', '--snippet', '-'], ctx.scope)}`,
    );
  const shown = names.length ? names.map((n) => `${kind}:${n}`).join(' ') : '<name>';
  const example = exampleFor(names.length ? names : ['tdd'], ctx);
  return usage(
    `"${word}" is a kind (${what}), not a repository. palm installs ${what} from git repositories:`,
    [
      exampleLine(`palm install <owner/repo> ${shown}`, example),
      searchLine([...names, ...KIND_SEARCH[kind]]),
    ].join('\n'),
  );
}
