/**
 * X13 M9: the same entity installed in both scopes (by the team in the project and by the person
 * with -g) for a harness both render for: that harness lists it twice. `check` warns with this
 * data; nothing is read beyond the two palm.yaml and lock files, nothing is written.
 */
import type { Kind, PalmContext, Scope, TargetId } from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import { openScope, type ScopeState } from './scope.js';

export interface ScopeTwin {
  kind: Kind;
  name: string;
  /** The source in this scope. */
  source: string;
  /** The other scope and the source it installed the entity from. */
  other: { scope: Scope; source: string };
  /** The harnesses both scopes render it for. */
  targets: TargetId[];
}

async function otherScope(ctx: PalmContext, scope: Scope): Promise<ScopeState | undefined> {
  const other: Scope = scope === 'project' ? 'global' : 'project';
  if (other === 'project' && !ctx.paths.projectRoot) return undefined;
  return openScope(ctx, other, { readOnly: true }).catch(() => undefined);
}

/** Entries of `state` whose kind and name the other scope also installs for a shared harness. */
export async function scopeTwins(ctx: PalmContext, state: ScopeState): Promise<ScopeTwin[]> {
  const twin = await otherScope(ctx, state.paths.scope);
  if (!twin) return [];
  const out: ScopeTwin[] = [];
  for (const e of state.lock.entries) {
    if (e.kind === 'plugin') continue;
    const match = twin.lock.entries.find((o) => o.kind === e.kind && sameName(o.name, e.name));
    if (!match) continue;
    const targets = (Object.keys(e.render) as TargetId[]).filter((t) => t in match.render);
    if (!targets.length) continue;
    const other = { scope: twin.paths.scope, source: match.source };
    out.push({ kind: e.kind, name: e.name, source: e.source, other, targets });
  }
  return out;
}
