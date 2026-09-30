/**
 * X13 M9, part of `double-load`: an entity installed in this project and globally (or the
 * reverse) for a harness both scopes render for is listed twice by that harness. The engine's
 * `scopeTwins` reads the other scope's palm.yaml and lock, never writes them.
 */
import type { Scope } from '../core/types.js';
import type { CheckContext, Found } from './check-kit.js';
import { palmCommand } from './report.js';
import { scopeTwins } from './twins.js';

const where = (scope: Scope): string => (scope === 'global' ? 'globally (-g)' : 'in this project');

/** Adds one warning per entity the other scope installs under the same kind and name. */
export async function scopesTwice(c: CheckContext, f: Found): Promise<void> {
  for (const t of await scopeTwins(c.run.ctx, c.run.state)) {
    const remove = palmCommand('remove', [t.other.source, `${t.kind}:${t.name}`], t.other.scope);
    const harnesses = t.targets.map((id) => c.run.deps.getTarget(id).displayName).join(', ');
    const lists = t.targets.length === 1 ? 'lists' : 'list';
    f.warn.push({
      entity: { kind: t.kind, name: t.name, source: t.source },
      message: `also installed ${where(t.other.scope)}; ${harnesses} ${lists} it twice`,
      fix: `keep one: ${remove}, or remove it here`,
    });
  }
}
