/**
 * Sources to checkouts and indexes (DESIGN §5), the first declaration of a source typed on the
 * command line, and matching `[kind:]name` requests within one source's index.
 */

import { getIndex } from '../core/cache.js';
import { PalmError } from '../core/errors.js';
import { defaultBranch, fetchSource, isSemverRange, resolveRef } from '../core/git.js';
import { deriveSourceName, parseSourceInput } from '../core/source-input.js';
import type {
  EngineDeps,
  Entity,
  EntityRefSpec,
  LockSource,
  PalmContext,
  Scope,
  Source,
  SourceCheckout,
  SourceIndex,
} from '../core/types.js';
import { entityId } from '../domain/entity-key.js';
import { formatEntityRef, sameName } from '../domain/entity-ref.js';
import { SourceRef } from '../domain/source.js';
import { logMark, palmCommand } from './report.js';
import type { ScopeState } from './scope.js';

export interface Resolved {
  checkout: SourceCheckout;
  index: SourceIndex;
}

const resolved = new WeakMap<ScopeState, Map<string, Promise<Resolved>>>();

/**
 * Fetches (git) or hashes (local) a source and indexes it: at the locked sha when `sha` is
 * given (bare install), else at the source's ref intent. One fetch per source and sha per run.
 */
export interface ResolveJob {
  ctx: PalmContext;
  deps: EngineDeps;
  state: ScopeState;
  ref: SourceRef;
  /** The locked commit (bare install, check); else the ref intent resolves. */
  sha?: string;
  /** Resolve the ref intent again (update). */
  refresh?: boolean;
}

export async function resolveSource(job: ResolveJob): Promise<Resolved> {
  const { ctx, deps, state, ref } = job;
  const opts = {
    ...(job.sha ? { sha: job.sha } : {}),
    ...(job.refresh ? { refresh: true } : {}),
  };
  const memo = resolved.get(state) ?? new Map<string, Promise<Resolved>>();
  resolved.set(state, memo);
  const key = `${ref.name}\0${opts.sha ?? ref.source.ref ?? ''}\0${opts.refresh ? 1 : 0}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = fetchAndIndex(ctx, deps, ref, { ...opts, exclude: await ownedInside(state, ref) });
    memo.set(key, pending);
    pending.catch(() => memo.delete(key));
  }
  return pending;
}

/**
 * A local source at the scope root holds palm's own outputs: its tree hash leaves out every
 * path the lock owns (DESIGN §4 "Source tree hash"). Other sources hold none (overlap rule).
 */
async function ownedInside(state: ScopeState, ref: SourceRef): Promise<Set<string> | undefined> {
  if (!ref.isLocal || !ref.source.path) return undefined;
  const { paths } = state;
  const [src, root] = await Promise.all([
    paths.realInside(ref.source.path),
    paths.realInside(paths.root),
  ]);
  if (src.real !== root.real) return undefined;
  return new Set(state.lock.entries.flatMap((e) => e.files));
}

async function fetchAndIndex(
  ctx: PalmContext,
  deps: EngineDeps,
  ref: SourceRef,
  opts: { sha?: string; refresh?: boolean; exclude?: Set<string> | undefined },
): Promise<Resolved> {
  const fetchOpts = {
    ...(opts.sha ? { sha: opts.sha } : {}),
    ...(opts.refresh ? { refresh: true } : {}),
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
  };
  const checkout = await fetchSource(ctx, ref.source, fetchOpts);
  const index = await getIndex(ctx, checkout, {
    scan: deps.scan,
    ...(opts.refresh ? { refresh: true } : {}),
  });
  return { checkout, index };
}

/**
 * The lock's record of a resolved source: enough to rebuild its index anywhere (DESIGN §4).
 * At the locked sha, the tag a range resolved to is kept as the lock has it.
 */
export function lockSourceOf(state: ScopeState, ref: SourceRef, r: Resolved): LockSource {
  const { source } = ref;
  const out: LockSource = {};
  if (ref.isLocal && source.path) {
    out.path = state.paths.lockForm(source.path);
    if (r.checkout.tree) out.tree = r.checkout.tree;
  } else Object.assign(out, gitLockFields(source, r.checkout, state.lock.source(ref.name)));
  if (source.layout) out.layout = source.layout;
  out.descriptor = r.index.detected;
  return out;
}

function gitLockFields(
  source: Source,
  checkout: SourceCheckout,
  previous?: LockSource,
): LockSource {
  const out: LockSource = {};
  if (source.url) out.url = source.url;
  if (source.root) out.root = source.root;
  if (source.ref) out.ref = source.ref;
  const same = previous?.sha !== undefined && previous.sha === checkout.sha;
  const tag = same ? previous?.resolved : checkout.ref;
  if (source.ref && isSemverRange(source.ref) && tag) out.resolved = tag;
  if (checkout.sha) out.sha = checkout.sha;
  return out;
}

/** The locked sha to fetch: the lock's, while palm.yaml's ref still equals the lock's ref. */
export function lockedSha(state: ScopeState, ref: SourceRef): { sha?: string } {
  const ls = state.lock.source(ref.name);
  if (ref.isLocal || !ls?.sha || ls.ref !== ref.source.ref) return {};
  if (ls.url && ref.source.url && ls.url !== ref.source.url) return {};
  return { sha: ls.sha };
}

/** `owner/repo#v2` → [`owner/repo`, `v2`]. */
function splitRef(input: string): [string, string | undefined] {
  const at = input.indexOf('#');
  return at < 0 ? [input, undefined] : [input.slice(0, at), input.slice(at + 1) || undefined];
}

/** `^1.0` for `v1.0.2`; undefined for anything that is not a release tag. */
function caretOf(tag: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.\d+$/.exec(tag);
  return m ? `^${m[1]}.${m[2]}` : undefined;
}

/**
 * A git source without `#ref`: the latest release as `^M.m`, else the default branch, written
 * explicitly and reported (DESIGN §5 "Input forms").
 */
async function defaultRef(ctx: PalmContext, source: Source): Promise<Source> {
  if (source.type !== 'git' || source.ref || !source.url) return source;
  const r = await resolveRef(source.url, undefined);
  const caret = caretOf(r.resolved);
  if (caret) {
    const branch = (await defaultBranch(source.url).catch(() => undefined)) ?? 'main';
    ctx.log.info(
      `ref ${caret} saved to palm.yaml (latest tag ${r.resolved}); edit ref: to track ${branch}`,
    );
    return { ...source, ref: caret };
  }
  ctx.log.info(`ref ${r.ref} saved to palm.yaml; edit ref: to pin a tag`);
  return { ...source, ref: r.ref };
}

async function confirmRefChange(
  ctx: PalmContext,
  existing: SourceRef,
  ref: string,
  yes: boolean,
): Promise<void> {
  const line = `source ${existing.name}: ref ${existing.source.ref ?? '(none)'} → ${ref}`;
  if (yes) return ctx.log.info(line);
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `${line} needs confirmation`,
      'confirm it by running',
      {
        retryWith: '--yes',
      },
    );
  if (!(await ctx.ui.confirm(`Change ${line}?`, false)))
    throw new PalmError('E_CANCELLED', 'cancelled; palm.yaml is unchanged');
}

/**
 * Re-declaring a known location under another `--as` name renames the source in palm.yaml and
 * the lock (DESIGN §5); its entries follow, and a later render moves their asset paths.
 */
function rename(ctx: PalmContext, state: ScopeState, existing: SourceRef, to: string): SourceRef {
  if (state.sources.byName(to))
    throw new PalmError(
      'E_CONFLICT',
      `palm.yaml already declares a source named ${to}`,
      palmCommand('install', [to], state.paths.scope),
    );
  const from = existing.name;
  const moved: Source = { ...existing.source, name: to };
  state.manifest.renameSource(from, to);
  state.lock.renameSource(from, to);
  state.sources = state.sources.without(from).add(moved);
  logMark(ctx, '~', `source ${from} → ${to} (renamed)`);
  return state.sources.byName(to) ?? SourceRef.of(moved);
}

/** Re-declaring a known source: another `#ref` moves the intent (after confirmation). */
async function redeclare(
  ctx: PalmContext,
  state: ScopeState,
  known: SourceRef,
  input: { ref?: string; as?: string; yes: boolean },
): Promise<SourceRef> {
  const renamed = input.as && !sameName(input.as, known.name);
  const existing = renamed ? rename(ctx, state, known, input.as as string) : known;
  const { ref } = input;
  if (!ref || ref === existing.source.ref) return existing;
  if (existing.isLocal)
    throw new PalmError(
      'E_USAGE',
      'a directory has no refs',
      'use a file:// URL for a tagged checkout',
    );
  await confirmRefChange(ctx, existing, ref, input.yes);
  const moved: Source = { ...existing.source, ref };
  state.manifest.addSource(moved, baseDirOf(state));
  state.sources = state.sources.add(moved);
  return state.sources.byName(existing.name) ?? SourceRef.of(moved);
}

function baseDirOf(state: ScopeState): string {
  return state.paths.scope === 'global' ? state.paths.palmHome : state.paths.root;
}

/** CLI input as a Source; a local path is named relative to the manifest's directory. */
function parseInput(ctx: PalmContext, state: ScopeState, input: string, as?: string): Source {
  const opts = { cwd: ctx.paths.cwd, projectRoot: baseDirOf(state), ...(as ? { as } : {}) };
  return parseSourceInput(input, opts);
}

/**
 * DESIGN §5 "Input forms": a declared name, alias or location is itself (a new `#ref` moves the
 * intent after confirmation); anything else is parsed, named, given an explicit ref (reported)
 * and added to palm.yaml. The lock records it once it resolved.
 */
/** A declared source `input` names (name, alias or location), and the parsed input when it is new. */
function findDeclared(
  ctx: PalmContext,
  state: ScopeState,
  input: string,
  as?: string,
): { known?: SourceRef; parsed?: Source; ref?: string } {
  const [head, ref] = splitRef(input);
  const byName = state.sources.byName(head);
  if (byName) return { known: byName, ...(ref ? { ref } : {}) };
  const parsed = parseInput(ctx, state, input, as);
  const probe = SourceRef.of(parsed);
  const known = state.sources.all().find((s) => s.sameLocation(probe));
  return { ...(known ? { known } : {}), parsed, ...(parsed.ref ? { ref: parsed.ref } : {}) };
}

/**
 * DESIGN §5 "Input forms": a declared name, alias or location is itself (a new `#ref` moves the
 * intent after confirmation); anything else is parsed, named, given an explicit ref (reported)
 * and added to palm.yaml. The lock records it once it resolved.
 */
export async function declareSource(
  ctx: PalmContext,
  state: ScopeState,
  input: string,
  opts: { as?: string; yes: boolean },
): Promise<SourceRef> {
  const found = findDeclared(ctx, state, input, opts.as);
  if (found.known)
    return redeclare(ctx, state, found.known, {
      ...opts,
      ...(found.ref ? { ref: found.ref } : {}),
    });
  const parsed = found.parsed as Source;
  const name = opts.as ?? deriveSourceName(parsed, state.sources.names());
  const source = await defaultRef(ctx, { ...parsed, name });
  state.manifest.addSource(source, baseDirOf(state));
  state.sources = state.sources.add(source);
  return state.sources.byName(name) ?? SourceRef.of(source);
}

/** A source as `palm install <source>` without names sees it: declared, or parsed and named (not saved). */
export function peekSource(
  ctx: PalmContext,
  state: ScopeState,
  input: string,
): { ref: SourceRef; declared: boolean } {
  const found = findDeclared(ctx, state, input);
  if (found.known) return { ref: found.known, declared: true };
  const parsed = found.parsed as Source;
  const name = deriveSourceName(parsed, state.sources.names());
  return { ref: SourceRef.of({ ...parsed, name }), declared: false };
}

// ---------------------------------------------------------------------------
// Matching names within one source
// ---------------------------------------------------------------------------

export interface NameMatch {
  entities: Entity[];
  plugins: Array<{ plugin: Entity; members: Entity[] }>;
  missing: EntityRefSpec[];
  ambiguous: EntityRefSpec[];
}

/** The index entities a plugin declares (a member found through this plugin wins). */
export function membersOf(index: SourceIndex, plugin: Entity): Entity[] {
  if (plugin.def.kind !== 'plugin') return [];
  const out: Entity[] = [];
  for (const m of plugin.def.members) {
    const cands = index.entities.filter((e) => e.kind === m.kind && sameName(e.name, m.name));
    const pick = cands.find((e) => e.plugin === plugin.name) ?? cands[0];
    if (pick) out.push(pick);
  }
  return out;
}

function everything(index: SourceIndex): Pick<NameMatch, 'entities' | 'plugins'> {
  const plugins = index.entities
    .filter((e) => e.kind === 'plugin')
    .map((plugin) => ({ plugin, members: membersOf(index, plugin) }));
  const inPlugin = new Set(plugins.flatMap((p) => p.members.map(entityId)));
  const entities = index.entities.filter(
    (e) => e.kind !== 'plugin' && !e.plugin && !inPlugin.has(entityId(e)),
  );
  return { entities, plugins };
}

function candidates(index: SourceIndex, spec: EntityRefSpec): Entity[] {
  return index.entities.filter(
    (e) => sameName(e.name, spec.name) && (!spec.kind || e.kind === spec.kind),
  );
}

/**
 * `[kind:]name` requests against one source's index (DESIGN §6 step 3): case-insensitive; a
 * name that means two kinds is ambiguous; a plugin expands to its members. `all` takes every
 * plugin and every entity outside a plugin.
 */
export function matchNames(index: SourceIndex, names: EntityRefSpec[], all: boolean): NameMatch {
  const out: NameMatch = { entities: [], plugins: [], missing: [], ambiguous: [] };
  if (all) Object.assign(out, everything(index));
  for (const spec of names) {
    const cands = pluginFirst(index, candidates(index, spec));
    const kinds = new Set(cands.map((e) => e.kind));
    const [first] = cands;
    if (!first) out.missing.push(spec);
    else if (kinds.size > 1) out.ambiguous.push(spec);
    else if (first.kind === 'plugin')
      out.plugins.push({ plugin: first, members: membersOf(index, first) });
    else out.entities.push(first);
  }
  out.entities = dedupe(out.entities);
  out.plugins = out.plugins.filter(
    (p, i) => out.plugins.findIndex((q) => sameName(q.plugin.name, p.plugin.name)) === i,
  );
  return out;
}

/**
 * A name that is a plugin and also one of that plugin's own members (a plugin's hooks are often
 * named after it) means the plugin: installing it installs the member too.
 */
function pluginFirst(index: SourceIndex, cands: Entity[]): Entity[] {
  const plugin = cands.find((e) => e.kind === 'plugin');
  if (!plugin) return cands;
  const members = new Set(membersOf(index, plugin).map(entityId));
  return cands.every((e) => e === plugin || members.has(entityId(e))) ? [plugin] : cands;
}

function dedupe(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  return entities.filter((e) => !seen.has(entityId(e)) && seen.add(entityId(e)));
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(tmp + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** The index name closest to `spec` (edit distance up to 3, or a substring), if any. */
export function closestName(index: SourceIndex, spec: EntityRefSpec): string | undefined {
  const q = spec.name.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const e of index.entities) {
    if (spec.kind && e.kind !== spec.kind) continue;
    const n = e.name.toLowerCase();
    const d = n.includes(q) || q.includes(n) ? Math.min(distance(q, n), 1) : distance(q, n);
    if (d <= 3 && (!best || d < best.d)) best = { name: e.name, d };
  }
  return best?.name;
}

/** E_NOT_FOUND for names the source lacks; E_AMBIGUOUS for names meaning two kinds. */
export function matchError(
  source: string,
  index: SourceIndex,
  match: NameMatch,
  scope: Scope,
): PalmError | undefined {
  const [missing] = match.missing;
  if (missing) {
    const near = closestName(index, missing);
    const shown = missing.kind ? `${missing.kind}:${missing.name}` : missing.name;
    const words = near ? [source, near] : [source];
    const guess = near ? `; did you mean ${near}?` : '; list what it offers:';
    return new PalmError(
      'E_NOT_FOUND',
      `"${shown}" is not in source ${source}${guess}`,
      palmCommand('install', words, scope),
    );
  }
  const [amb] = match.ambiguous;
  if (!amb) return undefined;
  const forms = candidates(index, amb).map((e) => formatEntityRef(e));
  return new PalmError(
    'E_AMBIGUOUS',
    `"${amb.name}" names ${forms.length} kinds in source ${source}: ${forms.join(', ')}`,
    palmCommand('install', [source, forms[0] ?? amb.name], scope),
  );
}
