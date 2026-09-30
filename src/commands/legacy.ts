/**
 * The palm 0.1 forms that still work for one release (DESIGN.md §10): `[kind] name@alias` with
 * the alias resolved against palm.yaml (a declared name, the repository or owner of a declared
 * source, or ~/.palm/config.yaml), `install origin <spec>`, and the removed install flags
 * (`--frozen`, `--from`, `--ref`, `--alias`, `--project`), each answered with the 0.2 command.
 * Pure: the grammar and `palm --help` load this module.
 */
import { PalmError } from '../core/errors.js';
import { parseKind } from '../core/kinds.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { EntityRefSpec, Kind, Scope } from '../core/types.js';
import { isLegacyDepString, parseEntityRef } from '../domain/entity-ref.js';
import type { InstallWords } from './grammar.js';
import {
  exampleLine,
  formatName,
  type GrammarContext,
  inputOf,
  knownRepo,
  palmLine,
  shellWord,
  sourceFor,
} from './hints.js';

function usage(message: string, hint?: string): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

/** The kind word of the 0.1 grammar (`install skill tdd`), when more words follow it. */
export function kindWord(words: readonly string[]): Kind | undefined {
  const [first = '', second] = words;
  return second !== undefined && !first.includes(':') ? parseKind(first) : undefined;
}

/** `[kind] a b` as names: the kind word narrows each name. */
function kindNames(words: readonly string[]): EntityRefSpec[] {
  const kind = kindWord(words);
  const rest = kind ? words.slice(1) : words;
  return rest.map((w) => (kind ? { kind, name: w } : parseEntityRef(w)));
}

/** `palm <verb> <source> <[kind:]name…>[ -g]`. */
export function commandLine(
  verb: string,
  source: string | undefined,
  names: readonly EntityRefSpec[],
  scope?: Scope,
): string {
  return palmLine(verb, [source ?? '', ...names.map(formatName)], scope);
}

// name@alias#ref --------------------------------------------------------------------------------

interface Tagged {
  name: string;
  alias?: string;
  ref?: string;
}

const TAGGED = /^([^@#]+)(?:@([^#]+))?(?:#(.+))?$/;

function tagged(word: string): Tagged {
  const m = TAGGED.exec(word);
  return m ? { name: m[1] as string, alias: m[2], ref: m[3] } : { name: word };
}

/** What installs from an alias's source: its location (a directory takes no ref). */
function pinned(source: string, ref: string, ctx: GrammarContext): string {
  const input = inputOf(source, ctx).split('#')[0] ?? source;
  return /^[./~]/.test(input) ? input : `${input}#${ref}`;
}

/** C23, D10: `tdd@alias#ref`: the ref goes with the source, as the source's location. */
function pinnedName(alias: string, ref: string, names: EntityRefSpec[], ctx: GrammarContext) {
  const source = sourceFor(alias, ctx) ?? knownRepo(alias);
  const shown = names.map(formatName).join(' ');
  const message = 'a version belongs to the source, not to a name';
  if (source)
    return usage(message, `  ${palmLine('install', [pinned(source, ref, ctx), shown], ctx.scope)}`);
  const example = palmLine('install', [`mattpocock/skills#${ref}`, shown], ctx.scope);
  return usage(message, exampleLine(`palm install <owner/repo>#${ref} ${shown}`, example));
}

/** E16: an alias nothing resolves: the 0.2 form, with the well-known repository when there is one. */
function unknownAlias(alias: string, names: EntityRefSpec[], ctx: GrammarContext): PalmError {
  const shown = names.map(formatName).join(' ');
  const message = `"${alias}" is a palm 0.1 alias and palm.yaml declares no source for it`;
  const known = knownRepo(alias);
  if (known)
    return usage(
      `${message}; did you mean ${known}?`,
      `  ${palmLine('install', [known, shown], ctx.scope)}`,
    );
  const declared = ctx.sources?.[0]?.name ?? 'mattpocock/skills';
  const example = palmLine('install', [declared, shown], ctx.scope);
  return usage(
    `${message}. Name its repository:`,
    exampleLine(`palm install <owner/repo> ${shown}`, example),
  );
}

/** J8: names from several aliases: one line per source, each pasteable on its own. */
function perSource(verb: string, items: Tagged[], kind: Kind | undefined, ctx: GrammarContext) {
  const aliases = [...new Set(items.flatMap((t) => (t.alias ? [t.alias] : [])))];
  const lines = aliases.map((alias) => {
    const names = items.filter((t) => t.alias === alias).map((t) => named(t.name, kind));
    const source = sourceFor(alias, ctx) ?? knownRepo(alias);
    if (source) return `  ${commandLine(verb, source, names, ctx.scope)}`;
    const shown = names.map(formatName).join(' ');
    return exampleLine(
      `palm ${verb} <owner/repo> ${shown}`,
      commandLine(verb, 'mattpocock/skills', names, ctx.scope),
    );
  });
  return usage(
    `these names come from ${aliases.length} sources; palm ${verb} takes one at a time:`,
    lines.join('\n'),
  );
}

const named = (name: string, kind?: Kind): EntityRefSpec => (kind ? { kind, name } : { name });

/**
 * `[kind] name@alias[#ref]…` (palm 0.1): the alias as a source. While commander parses (no
 * `isDeclared`) the alias is kept for the command, which reads palm.yaml and decides. An alias
 * that resolves prints the 0.2 form and runs it; remove without a resolved alias removes by name.
 */
export function legacyAlias(
  verb: 'install' | 'remove',
  words: string[],
  ctx: GrammarContext,
): InstallWords | undefined {
  const kind = kindWord(words);
  const items = (kind ? words.slice(1) : words).map(tagged);
  const aliases = [...new Set(items.flatMap((t) => (t.alias ? [t.alias] : [])))];
  const [alias] = aliases;
  if (!alias) return undefined;
  const names = items.map((t) => named(t.name, kind));
  if (!ctx.isDeclared) return { source: alias, names };
  if (aliases.length > 1) throw perSource(verb, items, kind, ctx);
  const ref = items.find((t) => t.ref)?.ref;
  if (ref && verb === 'install') throw pinnedName(alias, ref, names, ctx);
  const source = sourceFor(alias, ctx);
  if (!source && verb === 'install') throw unknownAlias(alias, names, ctx);
  const form = `palm ${verb} ${words.join(' ')}`;
  const replacement = commandLine(verb, source, names, ctx.scope);
  return { ...(source ? { source } : {}), names, legacy: { form, replacement } };
}

/**
 * The names after a source. A 0.1 `name@alias` or `name#ref` among them is E_USAGE whose hint is
 * this command with plain names (the ref moved to the source's location).
 */
export function sourcedNames(
  verb: 'install' | 'remove',
  source: string,
  words: string[],
  ctx: GrammarContext,
): EntityRefSpec[] {
  if (!words.some(isLegacyDepString)) return words.map((w) => parseEntityRef(w));
  const items = words.map(tagged);
  const names = items.map((t) => parseEntityRef(t.name));
  const ref = items.find((t) => t.ref)?.ref;
  const where = ref && verb === 'install' ? pinned(source, ref, ctx) : source;
  const message = ref
    ? 'a version belongs to the source, not to a name'
    : 'name@source is the palm 0.1 form; the source is the first word';
  throw usage(message, `  ${commandLine(verb, where, names, ctx.scope)}`);
}

/** `palm install origin <spec> [names]`; several repositories get one line each (J8). */
export function legacyOrigin(rest: string[], ctx: GrammarContext): InstallWords {
  const [spec, ...words] = rest;
  if (!spec)
    throw usage(
      'name the repository to install from',
      palmLine('install', ['obra/superpowers'], ctx.scope),
    );
  const specs = rest.filter((w) => looksLikeSourceInput(w));
  if (specs.length > 1)
    throw usage(
      `install origin names ${specs.length} repositories; palm lists one source at a time:`,
      specs.map((s) => `  ${palmLine('install', [s], ctx.scope)}`).join('\n'),
    );
  const names = words.map((w) => parseEntityRef(w));
  const replacement = commandLine('install', spec, names, ctx.scope);
  return { source: spec, names, legacy: { form: 'palm install origin', replacement } };
}

// removed install flags ----------------------------------------------------------------------------

/** The palm 0.1 install flags palm 0.2 answers with a replacement (E4, B7, C9, D8). */
export interface RemovedFlags {
  frozen?: boolean;
  from?: string;
  ref?: string;
  alias?: string;
  project?: boolean;
}

/** Options whose value is the next word, for rebuilding a command line. */
const VALUE_OPTIONS = new Set([
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
]);

const DROPPED = new Set(['--from', '--ref', '--alias', '--project', '--frozen']);

/** The flags of `argv` (the command line), without the removed ones and their values. */
function keptFlags(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('-')) continue;
    const name = a.split('=')[0] as string;
    const takesNext = VALUE_OPTIONS.has(name) && !a.includes('=');
    if (!DROPPED.has(name)) kept.push(a, ...(takesNext ? [argv[i + 1] ?? ''] : []));
    if (takesNext) i++;
  }
  return kept.filter(Boolean).map(shellWord);
}

/** `--ref r`: the ref goes after the source's location. */
function refLine(words: string[], ref: string, flags: string[], ctx: GrammarContext): string {
  const [first = '', ...rest] = words;
  if (ctx.isDeclared?.(first) || looksLikeSourceInput(first))
    return palmLine('install', [pinned(first, ref, ctx), ...rest, ...flags]);
  const names = kindNames(words).map(formatName);
  return palmLine('install', [`mattpocock/skills#${ref}`, ...names, ...flags]);
}

/**
 * A removed install flag: `--frozen` is undefined here (the command runs `palm check`); the
 * others are E_USAGE whose message ends with the palm 0.2 command.
 */
export function removedFlagError(
  words: string[],
  flags: RemovedFlags,
  argv: readonly string[],
  ctx: GrammarContext = {},
): PalmError | undefined {
  const kept = keptFlags(argv);
  if (flags.from !== undefined) {
    const names = kindNames(words).map(formatName);
    const line = palmLine('install', [flags.from, ...names, ...kept]);
    return usage(`--from is now the first word: ${line}`);
  }
  if (flags.ref !== undefined)
    return usage(`--ref is now #ref after the source: ${refLine(words, flags.ref, kept, ctx)}`);
  const line = palmLine('install', [...words.map(shellWord), ...kept]);
  if (flags.alias !== undefined)
    return usage(`--alias is now --as: ${line} --as ${shellWord(flags.alias)}`);
  if (flags.project) return usage(`--project is gone; palm uses the palm.yaml here: ${line}`);
  return undefined;
}
