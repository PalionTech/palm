/**
 * The errors of `palm install <source> …` as a person can act on them (PLAN.md §4.9): the command
 * an error offers is the command as typed with what was wrong corrected (K9, L20, O3, O7, O15),
 * a mistyped directory or repository gets the one it nearly is (Y20'), and a project's
 * directory under -g says why it is not visible there (K15, X12, Y21').
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { isPalmError, PalmError } from '../core/errors.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { EntityRefSpec, Kind } from '../core/types.js';
import type { ScopeState } from '../create/engine.js';
import type { App } from './app.js';
import { correctedNames } from './corrections.js';
import {
  formatName,
  KNOWN_SOURCES,
  manifestFile,
  nearest,
  pasteLine,
  sourceOptions,
  typedOptions,
} from './hints.js';

/** An install that names its source: the scope before it, the source and names as typed. */
export interface InstallJob {
  before: ScopeState;
  source: string;
  names: EntityRefSpec[];
}

/** The kinds a name is installed as from the run's source (O3: the kind a correction prefers). */
function installedKinds(job: InstallJob) {
  const source = job.before.sources.byName(job.source)?.name ?? job.source;
  return (name: string): Kind[] =>
    job.before.lock.entries
      .filter((e) => e.source === source && e.name.toLowerCase() === name.toLowerCase())
      .map((e) => e.kind);
}

/** `palm install <word>` alone (or with the `--as` the engine keeps): the listing line. */
function listsOnly(hint: string, word: string): boolean {
  const rest = hint.replace(/ -g$/, '').replace(/ --as \S+/g, '');
  return rest === `palm install ${word}`;
}

/** `palm install <source> <names…> <options…>` as typed, with another source or other names. */
function typedLine(app: App, job: InstallJob, source: string, names?: string[]): string {
  const words = names ?? job.names.map(formatName);
  return pasteLine('install', [source, ...words], typedOptions(app.argv), job.before.paths.scope);
}

/**
 * An error's command is the command as typed with its names corrected (the source with its
 * #ref, every option: --force, --as, --layout, -g), or the typed source's listing. An engine hint
 * that names a declared source otherwise stays.
 */
function rebuiltHint(e: PalmError, app: App, job: InstallJob): string | undefined {
  if (!e.hint?.startsWith('palm install ')) return e.hint;
  const corrected = correctedNames(e, job.names, installedKinds(job));
  if (corrected) return typedLine(app, job, job.source, corrected);
  const word = /^palm install (\S+)/.exec(e.hint)?.[1] ?? '';
  const scope = job.before.paths.scope;
  if (listsOnly(e.hint, word))
    return pasteLine('install', [job.source], sourceOptions(app.argv), scope);
  const known = looksLikeSourceInput(word) || job.before.sources.byName(word) !== undefined;
  return known ? e.hint : e.hint.replace(`palm install ${word}`, `palm install ${job.source}`);
}

/** N11: the source a message names, without the options the engine keeps beside it. */
function unglued(message: string): string {
  return message.replace(/(source \S+)(?: --(?:as|layout) \S+)+/g, '$1');
}

const isPath = (word: string) => /^\.{1,2}\//.test(word);

/** Y20': the sibling directory a mistyped `./path` nearly names. */
function nearDirectory(app: App, typed: string): string | undefined {
  const abs = resolve(app.cwd ?? process.cwd(), typed);
  try {
    const dirs = readdirSync(dirname(abs), { withFileTypes: true }).filter((d) => d.isDirectory());
    const near = nearest(
      basename(abs),
      dirs.map((d) => d.name),
    );
    return near ? `${typed.slice(0, typed.length - basename(abs).length)}${near}` : undefined;
  } catch {
    return undefined;
  }
}

/** Y20', Q15: the repository a 404 nearly names: a declared source, or a well-known one. */
function nearRepository(job: InstallJob): string | undefined {
  const typed = job.source.split('#')[0] ?? job.source;
  const declared = job.before.sources.all().map((s) => s.name);
  const near = nearest(typed, [...declared, ...KNOWN_SOURCES.map((k) => k.repo)]);
  return near && near !== typed ? near : undefined;
}

/** Y20': `did you mean …?` in front of an error about a path or repository that does not exist. */
function didYouMean(e: PalmError, app: App, job: InstallJob): PalmError | undefined {
  const missingDir = isPath(job.source) && /^no directory at /.test(e.message);
  const missingRepo = /^repository not found/.test(e.message);
  const near = missingDir ? nearDirectory(app, job.source) : missingRepo && nearRepository(job);
  if (!near) return undefined;
  const check = missingRepo && e.hint ? `\n  ${e.hint}` : '';
  return new PalmError(
    e.code,
    e.message,
    `did you mean ${near}? ${typedLine(app, job, near)}${check}`,
  );
}

/** K15, X12, Y21': a directory outside the global scope's root under -g is a project's own. */
function projectPath(e: PalmError, app: App, job: InstallJob): PalmError | undefined {
  const global = job.before.paths.scope === 'global';
  if (!global || !isPath(job.source) || !/is outside the project/.test(e.message)) return undefined;
  const local = typedOptions(app.argv, (name) => name !== '-g' && name !== '--global');
  const words = [job.source, ...job.names.map(formatName)];
  return new PalmError(
    'E_USAGE',
    `${job.source} is a directory of a project; -g uses ${manifestFile('global')} and directories under ~ only`,
    `install it in this project instead: ${pasteLine('install', words, local, 'project')}`,
  );
}

/**
 * The error of an install from a source, its message and its command as the person can paste
 * them. A multi-name install that stopped says it installed nothing.
 */
export function pasteable(e: unknown, app: App, job: InstallJob): unknown {
  if (!isPalmError(e)) return e;
  const reworded = projectPath(e, app, job) ?? didYouMean(e, app, job);
  if (reworded) return reworded;
  const hint = rebuiltHint(e, app, job);
  const message = unglued(e.message);
  if (hint === e.hint && message === e.message) return e;
  const many = hint !== e.hint && job.names.length > 1;
  if (many && !app.out.jsonMode) app.out.out('Nothing installed.');
  return new PalmError(e.code, message, hint, e.retryWith ? { retryWith: e.retryWith } : {});
}
