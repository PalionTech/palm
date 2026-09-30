/**
 * Failures and the pasteable commands their hints name. Every hint is a command that works when
 * pasted (PLAN.md 4.9): the source and entity names are real, never placeholders.
 */
import { isPalmError, messageOf, retryHint } from '../core/errors.js';
import type { InstallFailure, Kind, Scope, TargetId } from '../core/types.js';

/** What a failure is about: an entity of a source, or the source itself. */
export interface Subject {
  kind: Kind | 'source';
  name: string;
  source: string;
}

/** A failure for `subject` (optionally one target) from an error. */
export function failureOf(subject: Subject, error: unknown, target?: TargetId): InstallFailure {
  const f: InstallFailure = {
    kind: subject.kind,
    name: subject.name,
    source: subject.source,
    code: isPalmError(error) ? error.code : 'E_INTERNAL',
    message: messageOf(error),
  };
  if (target) f.target = target;
  const hint = isPalmError(error) ? retryHint(error) : undefined;
  if (hint) f.hint = hint;
  return f;
}

/** A failure built from its parts (refusals that never were an Error). */
export function failure(
  subject: Subject,
  code: string,
  text: { message: string; hint?: string },
  target?: TargetId,
): InstallFailure {
  const f: InstallFailure = { ...pick(subject), code, message: text.message };
  if (text.hint) f.hint = text.hint;
  if (target) f.target = target;
  return f;
}

function pick(s: Subject): Subject {
  return { kind: s.kind, name: s.name, source: s.source };
}

/** ` -g` under global scope. */
export function scopeFlag(scope: Scope): string {
  return scope === 'global' ? ' -g' : '';
}

/** `palm <verb> <words…>[ -g][ <extra>]`. */
export function palmCommand(verb: string, words: string[], scope: Scope, extra?: string): string {
  const tail = extra ? ` ${extra}` : '';
  return `palm ${[verb, ...words].join(' ')}${scopeFlag(scope)}${tail}`;
}

/** `palm install <source> <name>[ -g][ --force]` for one entity. */
export function installCommand(subject: Subject, scope: Scope, extra?: string): string {
  const words = subject.kind === 'source' ? [subject.source] : [subject.source, subject.name];
  return palmCommand('install', words, scope, extra);
}

/** `kind name` for messages. */
export function label(e: { kind: string; name: string }): string {
  return `${e.kind} ${e.name}`;
}
