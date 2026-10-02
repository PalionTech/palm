/**
 * `palm install <source> [names…]` (DESIGN §6 "Install with names"), `palm install <source>`
 * without names (list, save nothing) and `palm install mcp` (hand-declared servers, DESIGN §9).
 */
import { PalmError } from '../core/errors.js';
import { defaultBranch } from '../core/git.js';
import type {
  EngineDeps,
  Entity,
  EntityRefSpec,
  InstallOptions,
  InstallRequest,
  InstallResult,
  LayoutDescriptor,
  PalmContext,
  Scope,
  SourceCheckout,
  SourceIndex,
} from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { SourceRef } from '../domain/source.js';
import { indexNotes, isDependencyNote } from '../index/notes.js';
import { type Declared, declareSource, ensureRef, peekSource, reportRefs } from './declare.js';
import { resolveEngineDeps } from './deps.js';
import { dedupeJobs, manifestJobs, requestJobs } from './entries.js';
import { type Job, type Run, runOf } from './jobs.js';
import { askKinds, matchError, matchNames, type NameMatch, requestedRefs } from './match.js';
import { type Move, moveOf } from './moves.js';
import { gapOf, installedNames, preloadLine } from './preloads.js';
import { palmCommand } from './report.js';
import { lockSourceOf, pinOf, type Resolved, resolveSource } from './resolve.js';
import { runJobs, settle, withLockedScope } from './runner.js';
import { assertNoOverlap, openScope, type ScopeState } from './scope.js';
import { refuseLocal, requestTargets } from './targets.js';

export { installMcp } from './install-mcp.js';
export { requestInstallStop } from './runner.js';

/**
 * One line per agent whose preloads (`skills:`, `mcpServers:`) this install leaves missing
 * (K3): installed already, or named on this command line, counts as present.
 */
function notePreloads(run: Run, ref: SourceRef, match: NameMatch, index: SourceIndex): void {
  const lockHas = installedNames(run.state.lock.entries);
  const named = installedNames(
    match.entities.map((e) => ({ ...e, source: ref.name, content: '', render: {}, files: [] })),
  );
  const has = (kind: Entity['kind'], name: string) => lockHas(kind, name) || named(kind, name);
  for (const e of match.entities) {
    if (e.kind !== 'agent') continue;
    const gap = gapOf(run, { agent: e, source: ref.name, index }, has);
    if (gap) run.ctx.log.info(preloadLine(gap));
  }
}

function requestedJobs(
  run: Run,
  ref: SourceRef,
  r: Resolved,
  req: InstallRequest & { match: NameMatch },
): Job[] {
  const b = { state: run.state, ref, resolved: r };
  const { secrets } = run.ctx.flags;
  const opts = {
    ...(req.targets ? { targets: req.targets } : {}),
    ...(req.at ? { at: req.at } : {}),
    ...(secrets ? { secrets } : {}),
  };
  const direct = req.match.entities.flatMap((e: Entity) => requestJobs(b, e, opts));
  const plugins = req.match.plugins.flatMap((p) => requestJobs(b, p.plugin, opts));
  return [...direct, ...plugins];
}

/**
 * When the source moves to another commit, its other entries are rendered from the new one
 * too: one commit per source (C12 shows them before the move).
 */
function movedJobs(run: Run, ref: SourceRef, r: Resolved, move: Move | undefined): Job[] {
  if (!move) return [];
  const { jobs, failures } = manifestJobs(run.state, ref, r);
  run.result.failures.push(...failures);
  return jobs;
}

/** A source this run declares: its name, and the input as typed (what hints paste until it is saved). */
interface Held {
  added?: string;
  paste?: string;
}

/**
 * A new source that was not saved has no name palm.yaml knows: the failures' hints name it as
 * typed (K9: `palm install https://…/kit.git review --force`, not `palm install kit …`).
 */
function repaste(result: InstallResult, held: Held): void {
  const { added, paste } = held;
  if (!added || !paste || added === paste) return;
  const from = `palm install ${added}`;
  for (const f of result.failures)
    if (f.hint === from || f.hint?.startsWith(`${from} `))
      f.hint = `palm install ${paste}${f.hint.slice(from.length)}`;
}

/** A source this run declared that ended up with no entry leaves palm.yaml and the lock again. */
function forgetEmptySource(state: ScopeState, name: string): void {
  if (state.lock.entriesOf(name).length) return;
  if (!state.manifest.allEntries().some((e) => e.source === name))
    state.manifest.removeSource(name);
  state.lock.removeSource(name);
}

/** The source to install from: declared (or found), with a ref, and how to fetch it. */
async function sourceOf(run: Run, req: InstallRequest, held: Held) {
  const { ctx, state } = run;
  const decl: Declared = await declareSource(ctx, state, req.source, {
    ...(req.as ? { as: req.as } : {}),
    ...(req.layout ? { layout: req.layout } : {}),
  });
  if (decl.added) Object.assign(held, { added: decl.ref.name, paste: decl.paste });
  const refd = decl.added
    ? { ref: decl.ref, pin: decl.pin }
    : await ensureRef(ctx, state, decl.ref);
  return { decl, ref: refd.ref, pin: refd.pin ?? pinOf(state, refd.ref) };
}

/** What matching needs: the source, its resolved index, the request and the source as typed. */
interface Matching {
  ref: SourceRef;
  r: Resolved;
  req: InstallRequest;
  paste: string;
  /** palm.yaml declared the source before this run. */
  declared: boolean;
}

function shownSpec(spec: EntityRefSpec): string {
  return spec.kind ? `${spec.kind}:${spec.name}` : spec.name;
}

/** `kit#main` for `kit` (a typed `#ref` replaced), the names, then the rest of the pasted words. */
function atBranch(paste: string, branch: string, names: string[]): string[] {
  const [head = '', ...rest] = paste.split(' ');
  return [`${head.replace(/#.*$/, '')}#${branch}`, ...names, ...rest];
}

/**
 * T11: a name the source lacks at its ref (the latest tag) that its default branch has: the
 * error says so and the hint installs from the branch. Undefined when the branch has no such
 * name, or cannot be read.
 */
async function branchHint(run: Run, m: Matching, match: NameMatch): Promise<PalmError | undefined> {
  const [missing] = match.missing;
  const url = m.ref.source.url;
  if (!missing || !m.ref.isGit || !url) return undefined;
  const branch = await defaultBranch(url).catch(() => undefined);
  if (!branch || branch === m.ref.source.ref || branch === m.r.checkout.ref) return undefined;
  const { ctx, deps, state } = run;
  const at = SourceRef.of({ ...m.ref.source, ref: branch });
  const other = await resolveSource({ ctx, deps, state, ref: at, refresh: true }).catch(
    () => undefined,
  );
  if (!other || matchNames(other.index, [missing], false).missing.length) return undefined;
  const version = m.r.checkout.ref ?? m.ref.source.ref ?? 'its ref';
  const words = atBranch(m.paste, branch, m.req.names.map(shownSpec));
  return new PalmError(
    'E_NOT_FOUND',
    `"${shownSpec(missing)}" is not in source ${m.ref.name} at ${version}; its default branch ${branch} has it`,
    palmCommand('install', words, state.paths.scope),
  );
}

/**
 * The names matched against the index with every which-kind question answered on a terminal
 * (O4, M10) before anything is written (V7'); a name the source lacks or one still ambiguous
 * throws. The result records what the names resolved to (Q4).
 */
async function matched(run: Run, m: Matching): Promise<NameMatch> {
  const all = !!m.req.all;
  const first = matchNames(m.r.index, m.req.names, all);
  const match = await askKinds(run.ctx, m.r.index, first, all);
  const at = { source: m.paste, declared: m.declared };
  const err = matchError(at, m.r.index, match, run.state.paths.scope);
  if (err?.code === 'E_NOT_FOUND') throw (await branchHint(run, m, match)) ?? err;
  if (err) throw err;
  if (m.req.names.length) run.result.requested = requestedRefs(match);
  return match;
}

/**
 * Q6: `--all` that left every entity out because each is a program nobody allowed declares
 * nothing (no source, no plugin entry, no `exclude:`) and names the programs to install by name.
 */
function onlyPrograms(run: Run, had: ReadonlySet<string>, paste: string): void {
  const { outcomes } = run.result;
  const programs = outcomes.filter((o) => o.declined);
  const others = outcomes.filter((o) => !o.declined && o.entry.kind !== 'plugin');
  if (!programs.length || others.length || run.touched) return;
  run.excluded = [];
  for (const { entry } of outcomes) {
    if (had.has(lockId(entry))) continue;
    run.state.lock.remove(entry);
    run.state.manifest.removeEntry(entry.source, entry.kind, entry.name);
  }
  const names = programs.map((o) => `${o.entry.kind}:${o.entry.name}`);
  const line = palmCommand('install', [paste, ...names], run.state.paths.scope);
  run.ctx.log.info(`Nothing installed; the source offers only programs: ${line}`);
}

async function install(run: Run, req: InstallRequest, held: Held): Promise<void> {
  const { ctx, deps, state } = run;
  const scope = state.paths.scope;
  const { decl, ref, pin } = await sourceOf(run, req, held);
  await assertNoOverlap(ctx, state, deps);
  if (!req.names.length && !req.all)
    throw new PalmError(
      'E_USAGE',
      `name what to install from ${ref.name}`,
      palmCommand('install', [decl.paste], scope),
    );
  const r = await resolveSource({ ctx, deps, state, ref, ...pin });
  const match = await matched(run, { ref, r, req, paste: decl.paste, declared: !decl.added });
  // N1 R1' S5: the notes a person acts on print at install too; the source is declared by now
  for (const note of indexNotes(r.index.warnings, { declared: true }).shown)
    if (!isDependencyNote(note)) ctx.log.info(`${ref.name}: ${note}`);
  notePreloads(run, ref, match, r.index);
  const targets = requestTargets(state, req.targets);
  const jobs = requestedJobs(run, ref, r, { ...req, ...(targets ? { targets } : {}), match });
  const move = moveOf(state, ref, r.checkout, decl.before);
  state.lock.setSource(ref.name, lockSourceOf(state, ref, r));
  if (req.all) run.leaveOutPrograms = true;
  const all = dedupeJobs([...jobs, ...movedJobs(run, ref, r, move)]);
  const had = new Set(state.lock.entries.map(lockId));
  await runJobs(run, all, move ? { moves: [move] } : {});
  if (req.all) onlyPrograms(run, had, decl.paste);
}

/**
 * DESIGN §6 "Install with names": declare the source when new, resolve it (the locked sha
 * while the ref intent is unchanged, else fresh), match the names, render, show a moving
 * source's entries and confirm, ask consent once, apply entity by entity. Names that match
 * nothing throw before anything is written; per-entity and per-target problems are
 * `failures`. palm.yaml and the lock are written only when the run succeeded or wrote
 * something (K1, R6, Z1).
 */
export async function installFromSource(
  ctx: PalmContext,
  req: InstallRequest,
  opts: InstallOptions,
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  refuseLocal(opts);
  const deps = await resolveEngineDeps(depsIn);
  return withLockedScope(ctx, opts.scope, { deps }, async (state) => {
    const run = runOf(ctx, deps, state);
    const held: Held = {};
    let failed = true;
    try {
      await install(run, req, held);
      failed = false;
    } finally {
      if (held.added) forgetEmptySource(state, held.added);
      if (await settle(run, failed)) reportRefs(ctx, state);
      else repaste(run.result, held);
    }
    return run.result;
  });
}

/**
 * `palm install <source>` without names: fetch and index, save nothing. A declared source is
 * read at its locked commit (what an install would use), or at the `#ref` typed; anything else
 * resolves fresh (K8). The overlap rule applies here too (B19). `paste` is what the listing's
 * next lines start with: the input as typed until the source is declared (K9, D9).
 */
export async function listSource(
  ctx: PalmContext,
  input: string,
  opts: { scope: Scope; layout?: LayoutDescriptor },
  depsIn?: Partial<EngineDeps>,
): Promise<{
  source: SourceRef;
  checkout: SourceCheckout;
  index: SourceIndex;
  declared: boolean;
  paste: string;
}> {
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps, readOnly: true });
  const { ref, declared, paste } = peekSource(ctx, state, input, opts.layout);
  const probe =
    declared || !ref.isLocal ? state : { ...state, sources: state.sources.add(ref.source) };
  await assertNoOverlap(ctx, probe, deps);
  const r = await resolveSource({ ctx, deps, state, ref, ...pinOf(state, ref) });
  return { source: ref, checkout: r.checkout, index: r.index, declared, paste };
}
