/**
 * X13 M9, part of `double-load`: an entity installed in this project and globally (or the
 * reverse) is listed twice by the harnesses that read both scopes. The other scope's lock is
 * read, never written.
 */
import type { Kind, Scope } from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import { Lock } from '../domain/lock.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { type CheckContext, entityOf, type Found } from './check-kit.js';
import { palmCommand } from './report.js';

/** Kinds a harness lists by name, so one name in both scopes is listed twice. */
const LISTED: ReadonlySet<Kind> = new Set(['skill', 'agent', 'instruction', 'mcp', 'hook']);

function otherScope(scope: Scope): Scope {
  return scope === 'project' ? 'global' : 'project';
}

/** The lock of the other scope (the global one from a project, the project's under -g). */
async function otherLock(c: CheckContext): Promise<Lock | undefined> {
  const paths = ScopePaths.of(c.run.ctx, otherScope(c.run.state.paths.scope));
  if (paths.scope === 'project' && paths.root === paths.home) return undefined;
  return Lock.load(paths.lockFile).catch(() => undefined);
}

/** Adds one warning per entity the other scope installs under the same kind and name. */
export async function scopesTwice(c: CheckContext, f: Found): Promise<void> {
  const other = await otherLock(c);
  if (!other) return;
  const here = c.run.state.paths.scope;
  const there = here === 'project' ? 'globally (-g)' : 'in this project';
  for (const e of c.run.state.lock.entries) {
    if (!LISTED.has(e.kind)) continue;
    const twin = other.entries.find((o) => o.kind === e.kind && sameName(o.name, e.name));
    if (!twin) continue;
    const remove = palmCommand('remove', [twin.source, `${e.kind}:${e.name}`], otherScope(here));
    f.warn.push({
      entity: entityOf(e),
      message: `${e.kind} ${e.name} is installed here and ${there}; a harness that reads both lists it twice`,
      fix: `keep one: ${remove}, or remove it here`,
    });
  }
}
