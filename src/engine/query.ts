/**
 * Read-only questions about a scope: what is installed (`palm get`), one entity in detail
 * (`palm describe`), and which entry wrote a path.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type {
  EngineDeps,
  Entity,
  EntityRefSpec,
  Kind,
  LockEntry,
  LockExec,
  LockSource,
  PalmContext,
  Scope,
  TargetId,
} from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import { findPlaceholders, isRuntimeVar } from '../lib/placeholders.js';
import { resolveEngineDeps } from './deps.js';
import { runOf } from './jobs.js';
import type { RenderOutput } from './render.js';
import { palmCommand } from './report.js';
import { openScope, type ScopeState } from './scope.js';
import { renderLocked } from './verify.js';

export interface InstalledRow {
  entry: LockEntry;
  source: LockSource;
  layer: 'team' | 'local';
}

export interface EntityInfo {
  entry: LockEntry;
  entity?: Entity;
  source: LockSource;
  files: Partial<Record<TargetId, string[]>>;
  notes: string[];
  exec?: { commands: LockExec['commands']; hash: string; trusted: boolean };
  secrets?: Array<{ name: string; set: boolean }>;
  /** `manifest` (palm.yaml lists it) or `plugin:<name>`. */
  selectedBy: string;
}

function sourceFilter(state: ScopeState, source?: string): string | undefined {
  return source ? (state.sources.byName(source)?.name ?? source) : undefined;
}

/** Installed entries from the lock, filtered by kind, names and source (name or alias). */
export async function listInstalled(
  ctx: PalmContext,
  scope: Scope,
  q: { kind?: Kind; names?: string[]; source?: string } = {},
): Promise<InstalledRow[]> {
  const state = await openScope(ctx, scope, { readOnly: true });
  const source = sourceFilter(state, q.source);
  return state.lock.entries
    .filter((e) => !q.kind || e.kind === q.kind)
    .filter((e) => !q.names?.length || q.names.some((n) => sameName(n, e.name)))
    .filter((e) => !source || e.source === source)
    .map((entry) => ({
      entry,
      source: state.lock.source(entry.source) ?? {},
      layer: 'team' as const,
    }));
}

function notInstalled(q: EntityRefSpec & { source?: string }, scope: Scope): PalmError {
  const what = q.kind ? `${q.kind} ${q.name}` : `"${q.name}"`;
  const where = scope === 'global' ? 'globally' : 'in this project';
  return new PalmError(
    'E_NOT_FOUND',
    `${what} is not installed ${where}; list what is:`,
    palmCommand('get', [], scope),
  );
}

function pick(state: ScopeState, q: EntityRefSpec & { source?: string }): LockEntry {
  const source = sourceFilter(state, q.source);
  const hits = state.lock.select({
    name: q.name,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(source ? { source } : {}),
  });
  const [first, second] = hits;
  if (!first) throw notInstalled(q, state.paths.scope);
  if (second) {
    const forms = hits.map((e) => `${e.kind}:${e.name} from ${e.source}`);
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${q.name}" names ${hits.length} installed entries: ${forms.join(', ')}`,
      palmCommand('describe', [`${first.kind}:${first.name}`], state.paths.scope),
    );
  }
  return first;
}

function filesPerTarget(entry: LockEntry, out?: RenderOutput): Partial<Record<TargetId, string[]>> {
  const files: Partial<Record<TargetId, string[]>> = {};
  for (const id of Object.keys(entry.render) as TargetId[]) {
    const r = out?.renders[id];
    files[id] = r
      ? [...r.files.map((f) => f.path), ...new Set(r.fragments.map((f) => f.file))]
      : [...entry.files];
  }
  return files;
}

function secretsOf(ctx: PalmContext, entity?: Entity): EntityInfo['secrets'] {
  if (entity?.def.kind !== 'mcp') return undefined;
  const names = new Set(
    findPlaceholders(JSON.stringify(entity.def.mcp))
      .map((p) => p.name)
      .filter((n) => !isRuntimeVar(n)),
  );
  return [...names].map((name) => ({ name, set: ctx.env[name] !== undefined }));
}

/** `palm describe <name>`: one installed entity with its files per harness, notes, exec and secrets. */
export async function describeEntity(
  ctx: PalmContext,
  q: EntityRefSpec & { source?: string },
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<EntityInfo> {
  const deps = await resolveEngineDeps(depsIn);
  const quiet: PalmContext = { ...ctx, flags: { ...ctx.flags, dryRun: true } };
  const state = await openScope(quiet, opts.scope, { readOnly: true });
  const entry = pick(state, q);
  const out = await renderLocked(runOf(quiet, deps, state), entry).catch(() => undefined);
  const info: EntityInfo = {
    entry,
    source: state.lock.source(entry.source) ?? {},
    files: filesPerTarget(entry, out),
    notes: entry.notes ?? [],
    selectedBy: entry.via ?? 'manifest',
  };
  const entity = out?.entity;
  if (entity) info.entity = entity;
  if (entry.exec)
    info.exec = {
      commands: entry.exec.commands,
      hash: entry.exec.hash,
      trusted: (entry.trust ?? []).includes(entry.exec.hash),
    };
  const secrets = secretsOf(ctx, entity);
  if (secrets) info.secrets = secrets;
  return info;
}

/** `palm describe <path>`: the entries that wrote the path, hold files inside it, or merged into it. */
export async function ownerOfPath(
  ctx: PalmContext,
  query: string,
  opts: { scope: Scope },
): Promise<Array<{ entry: LockEntry; match: 'file' | 'inside' | 'merged'; file: string }>> {
  const state = await openScope(ctx, opts.scope, { readOnly: true });
  const expanded = query.startsWith('~/')
    ? resolve(ctx.paths.home || homedir(), query.slice(2))
    : query;
  let lockPath: string;
  try {
    lockPath = state.paths.lockForm(resolve(ctx.paths.cwd, expanded));
  } catch {
    return [];
  }
  const out: Array<{ entry: LockEntry; match: 'file' | 'inside' | 'merged'; file: string }> = [];
  for (const entry of state.lock.entries) {
    const file = entry.files.find((f) => f === lockPath);
    const inside = entry.files.find((f) => f.startsWith(`${lockPath}/`));
    const merged = (entry.merged ?? []).find((m) => m.file === lockPath);
    if (file) out.push({ entry, match: 'file', file });
    else if (inside) out.push({ entry, match: 'inside', file: inside });
    else if (merged) out.push({ entry, match: 'merged', file: merged.file });
  }
  return out;
}

/** 0.3: the bytes each harness loads at every session. 0.2 returns nothing (reserved). */
export async function loadCost(
  _ctx: PalmContext,
  _scope: Scope,
): Promise<Partial<Record<TargetId, { bytes: number; entries: number }>>> {
  return {};
}
