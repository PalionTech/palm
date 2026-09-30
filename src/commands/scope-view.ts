/**
 * The sources and the targets of a scope, as `get sources`, `get targets` and `describe` show
 * them. Everything comes from palm.yaml and the lock (`openScope`); nothing is fetched.
 */

import type { PalmContext } from '../core/types.js';
import { type LockSource, TARGET_IDS, type TargetId } from '../core/types.js';
import {
  engineDepsOf,
  engineOf,
  type ScopeState,
  type SourceRef,
  targetOf,
} from '../create/engine.js';
import { shortHash } from '../ui/format.js';
import type { App } from './app.js';
import { displayPath, homePath } from './shared.js';

/** J10: a server declared in palm.yaml, whose lock source is `manifest`, reads as `palm.yaml`. */
export function sourceLabel(source: string): string {
  return source === 'manifest' ? 'palm.yaml' : source;
}

/** B16: the directory the scope's paths resolve against, as a person reads it. */
export function scopeRoot(ctx: PalmContext, state: ScopeState): string {
  return homePath(ctx, state.paths.root);
}

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

/** palm.yaml's targets, else what an install would detect here. */
export async function activeTargets(
  app: App,
  ctx: PalmContext,
  state: ScopeState,
): Promise<TargetId[]> {
  if (state.manifest.targets || state.targets.length) return state.targets;
  const api = engineOf(app.deps);
  return api.detectTargets(ctx, state.paths, await api.resolveEngineDeps(engineDepsOf(app.deps)));
}

export async function targetViews(
  app: App,
  ctx: PalmContext,
  state: ScopeState,
): Promise<TargetView[]> {
  const views: TargetView[] = [];
  const active = await activeTargets(app, ctx, state);
  for (const id of TARGET_IDS) {
    const t = await targetOf(app.deps ?? {}, id);
    const dir = t.configDir(state.paths.scope, state.paths.root, ctx.env);
    views.push({
      id,
      name: t.displayName,
      active: active.includes(id),
      configDir: `${displayPath(ctx, dir, state.paths.scope)}/`,
    });
  }
  return views;
}

export function targetRows(views: TargetView[]): string[][] {
  return views.map((v) => [v.id, v.name, v.active ? 'yes' : 'no', v.configDir]);
}

export const TARGET_HEADER = ['target', 'harness', 'active', 'config dir'];
