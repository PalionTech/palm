/**
 * The sources and the targets of a scope, as `get sources`, `get targets` and `describe` show
 * them. Everything comes from palm.yaml and the lock (`openScope`); nothing is fetched.
 */

import type { PalmContext } from '../core/types.js';
import { type LockSource, TARGET_IDS, type TargetId } from '../core/types.js';
import { type ScopeState, type SourceRef, targetOf } from '../create/engine.js';
import { shortHash } from '../ui/format.js';
import type { App } from './app.js';
import { displayPath } from './shared.js';

/** `v1.2.3`, `^1.2 → v1.2.3`, `tree 10934f8`. */
export function refCell(s: Partial<LockSource>): string {
  if (s.tree) return `tree ${shortHash(s.tree)}`;
  if (s.ref && s.resolved && s.ref !== s.resolved) return `${s.ref} → ${s.resolved}`;
  return s.ref ?? s.resolved ?? '';
}

export interface SourceView {
  name: string;
  alias?: string;
  type: 'git' | 'local';
  location: string;
  ref: string;
  sha?: string;
  tree?: string;
  entries: number;
}

export function sourceView(state: ScopeState, ref: SourceRef): SourceView {
  const locked = state.lock.source(ref.name) ?? {};
  return {
    name: ref.name,
    ...(ref.alias ? { alias: ref.alias } : {}),
    type: ref.isLocal ? 'local' : 'git',
    location: ref.describe(),
    ref: refCell({ ...locked, ref: ref.source.ref ?? locked.ref }),
    ...(locked.sha ? { sha: locked.sha } : {}),
    ...(locked.tree ? { tree: locked.tree } : {}),
    entries: state.lock.entriesOf(ref.name).length,
  };
}

export function sourceRows(views: SourceView[]): string[][] {
  return views.map((v) => [
    v.name,
    v.alias ?? '',
    v.type,
    v.ref,
    shortHash(v.sha ?? v.tree),
    String(v.entries),
  ]);
}

export const SOURCE_HEADER = ['source', 'alias', 'kind', 'ref', 'sha/tree', 'entries'];

export interface TargetView {
  id: TargetId;
  name: string;
  active: boolean;
  configDir: string;
}

export async function targetViews(
  app: App,
  ctx: PalmContext,
  state: ScopeState,
): Promise<TargetView[]> {
  const views: TargetView[] = [];
  for (const id of TARGET_IDS) {
    const t = await targetOf(app.deps ?? {}, id);
    const dir = t.configDir(state.paths.scope, state.paths.root, ctx.env);
    views.push({
      id,
      name: t.displayName,
      active: state.targets.includes(id),
      configDir: displayPath(ctx, dir),
    });
  }
  return views;
}

export function targetRows(views: TargetView[]): string[][] {
  return views.map((v) => [v.id, v.name, v.active ? 'yes' : 'no', v.configDir]);
}

export const TARGET_HEADER = ['target', 'harness', 'active', 'config dir'];
