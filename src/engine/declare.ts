/**
 * Declaring a source typed on the command line (DESIGN §5 "Input forms"). A declared name,
 * alias or location is itself; `--as` with a new name renames it (ruling 22) unless the input
 * carries another `#ref`, which declares a second source for the same location (Z2); a new
 * `#ref` on a declared source moves its intent (the run shows and confirms the move, C12).
 * Anything else is parsed, named and given an explicit ref from one fresh resolution (K8),
 * reported once palm.yaml is saved. A git source declared by hand without `ref:` gets one on
 * its first install (K20). Nothing here writes a file: the run saves when it succeeds (K1, Z1).
 */
import { PalmError } from '../core/errors.js';
import { defaultBranch, resolveRef } from '../core/git.js';
import { worktreeRoot } from '../core/paths.js';
import { deriveSourceName, parseSourceInput } from '../core/source-input.js';
import type { PalmContext, Source } from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import { SourceRef } from '../domain/source.js';
import { logMark, palmCommand } from './report.js';
import type { Pin } from './resolve.js';
import type { ScopeState } from './scope.js';

export interface Declared {
  ref: SourceRef;
  /** The resolution that chose a new source's ref: fetch that commit (one resolution, K8). */
  pin?: Pin;
  /** True when this run adds the source to palm.yaml. */
  added: boolean;
  /** The declared source before this run gave it another ref (a new `#ref`). */
  before?: SourceRef;
  /** What to paste in hints while the source is not saved yet: the input as typed (K9, D9). */
  paste: string;
}

/** The line that reports a ref palm chose, printed once the source is really in palm.yaml. */
const refNotes = new WeakMap<ScopeState, Map<string, string>>();

function noteRef(state: ScopeState, name: string, text: string): void {
  const notes = refNotes.get(state) ?? new Map<string, string>();
  notes.set(name, text);
  refNotes.set(state, notes);
}

/**
 * Prints the `i ref ^1.2 saved to palm.yaml (latest tag v1.2.3); …` line of every source this
 * run gave a ref, once palm.yaml was saved (a dry run says `would be saved`).
 */
export function reportRefs(ctx: PalmContext, state: ScopeState): void {
  const notes = refNotes.get(state);
  if (!notes) return;
  for (const [name, note] of notes) {
    if (ctx.flags.dryRun) ctx.log.info(note.replace(' saved to ', ' would be saved to '));
    else if (state.manifest.hasSource(name)) ctx.log.info(note);
  }
  notes.clear();
}

/** `^1.0` for `v1.0.2`; undefined for anything that is not a release tag. */
function caretOf(tag: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.\d+$/.exec(tag);
  return m ? `^${m[1]}.${m[2]}` : undefined;
}

function manifestLabel(state: ScopeState): string {
  return state.paths.scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
}

/**
 * A git source without a ref: the latest release as `^M.m`, else the default branch, written
 * explicitly (DESIGN §5, ruling 18). The one resolution that chose it is the commit to fetch,
 * so the printed tag and the installed one agree (K8).
 */
async function withDefaultRef(
  state: ScopeState,
  source: Source,
): Promise<{ source: Source; pin?: Pin }> {
  if (source.type !== 'git' || source.ref || !source.url) return { source };
  const r = await resolveRef(source.url, undefined);
  const pin: Pin = { sha: r.sha, resolved: r.resolved };
  const caret = caretOf(r.resolved);
  const file = manifestLabel(state);
  if (!caret) {
    noteRef(state, source.name, `ref ${r.ref} saved to ${file}; edit ref: to pin a tag`);
    return { source: { ...source, ref: r.ref }, pin };
  }
  const branch = (await defaultBranch(source.url).catch(() => undefined)) ?? 'main';
  const tail = `(latest tag ${r.resolved}); edit ref: to track ${branch}`;
  noteRef(state, source.name, `ref ${caret} saved to ${file} ${tail}`);
  return { source: { ...source, ref: caret }, pin };
}

export function baseDirOf(state: ScopeState): string {
  return state.paths.scope === 'global' ? state.paths.palmHome : state.paths.root;
}

/** `source` in palm.yaml and the scope's source set (by name; its entries stay). */
function declare(state: ScopeState, source: Source): SourceRef {
  state.manifest.addSource(source, baseDirOf(state));
  state.sources = state.sources.add(source);
  return state.sources.byName(source.name) ?? SourceRef.of(source);
}

/**
 * K20: a git source declared by hand without `ref:` gets one on its first install (the lock
 * has no commit for it yet), written and reported like a source declared on the command line.
 */
export async function ensureRef(
  _ctx: PalmContext,
  state: ScopeState,
  ref: SourceRef,
): Promise<{ ref: SourceRef; pin?: Pin }> {
  if (!ref.isGit || ref.source.ref || state.lock.source(ref.name)?.sha) return { ref };
  const { source, pin } = await withDefaultRef(state, ref.source);
  return { ref: declare(state, source), ...(pin ? { pin } : {}) };
}

/**
 * Re-declaring a known location under another `--as` name renames the source in palm.yaml and
 * the lock (DESIGN §5); its entries follow. The body is written again under the new key, so a
 * url the old key implied (`owner/repo`) is spelled out (Z1).
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
  state.sources = state.sources.without(from);
  logMark(ctx, '~', `source ${from} → ${to} (renamed)`);
  return declare(state, moved);
}

/** The directory local paths may lie in: the repository of the project (B9), home under -g (J6). */
function withinOf(state: ScopeState): string {
  const { paths } = state;
  if (paths.scope === 'global') return paths.home;
  return worktreeRoot(paths.root) ?? paths.root;
}

/** CLI input as a Source; a local path is named relative to the manifest's directory. */
function parseInput(ctx: PalmContext, state: ScopeState, input: string, as?: string): Source {
  const opts = {
    cwd: ctx.paths.cwd,
    projectRoot: baseDirOf(state),
    within: withinOf(state),
    ...(as ? { as } : {}),
  };
  return parseSourceInput(input, opts);
}

/** `owner/repo#v2` → [`owner/repo`, `v2`]. */
function splitRef(input: string): [string, string | undefined] {
  const at = input.indexOf('#');
  return at < 0 ? [input, undefined] : [input.slice(0, at), input.slice(at + 1) || undefined];
}

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

/** Z2: `--as <name>` with another `#ref` than the declared source: a second source, not a rename. */
function isSecondSource(known: SourceRef, found: { ref?: string }, as?: string): boolean {
  if (!as || sameName(as, known.name)) return false;
  return found.ref !== undefined && found.ref !== known.source.ref;
}

/** The location of a declared source at another ref, for a second source (Z2). */
function secondOf(known: SourceRef, ref: string | undefined): Source {
  const { alias: _alias, ...location } = known.source;
  return { ...location, ...(ref ? { ref } : {}) };
}

/** A known source, renamed by `--as` and given another ref by `#ref` (in memory). */
function redeclare(
  ctx: PalmContext,
  state: ScopeState,
  known: SourceRef,
  input: { ref?: string; as?: string },
): { ref: SourceRef; before?: SourceRef } {
  const renamed = input.as && !sameName(input.as, known.name);
  const existing = renamed ? rename(ctx, state, known, input.as as string) : known;
  const { ref } = input;
  if (!ref || ref === existing.source.ref) return { ref: existing };
  if (existing.isLocal)
    throw new PalmError(
      'E_USAGE',
      'a directory has no refs',
      'use a file:// URL for a tagged checkout',
    );
  const moved = declare(state, { ...existing.source, ref });
  // Nothing installed moves: say so; a locked source shows its entries and asks (moves.ts).
  if (!state.lock.source(existing.name)?.sha)
    logMark(ctx, '~', `source ${existing.name}: ref ${existing.source.ref ?? '(none)'} → ${ref}`);
  return { ref: moved, before: existing };
}

/**
 * DESIGN §5 "Input forms": a declared name, alias or location is itself (another `#ref` moves
 * its intent; `--as` renames it, or with another `#ref` declares a second source); anything
 * else is parsed, named, given an explicit ref and added to palm.yaml (in memory).
 */
export async function declareSource(
  ctx: PalmContext,
  state: ScopeState,
  input: string,
  opts: { as?: string },
): Promise<Declared> {
  const paste = input.trim();
  const found = findDeclared(ctx, state, input, opts.as);
  if (found.known && !isSecondSource(found.known, found, opts.as)) {
    const r = redeclare(ctx, state, found.known, {
      ...opts,
      ...(found.ref ? { ref: found.ref } : {}),
    });
    return { ...r, added: false, paste: r.ref.name };
  }
  const parsed = found.parsed ?? secondOf(found.known as SourceRef, found.ref);
  const name = opts.as ?? deriveSourceName(parsed, state.sources.names());
  const { source, pin } = await withDefaultRef(state, { ...parsed, name });
  const ref = declare(state, source);
  return {
    ref,
    ...(pin ? { pin } : {}),
    added: true,
    paste: opts.as ? `${paste} --as ${name}` : paste,
  };
}

/**
 * A source as `palm install <source>` without names sees it (nothing saved): a declared one,
 * at the `#ref` typed when it differs from the declared ref (D9); else the input parsed and
 * named. `paste` is what the listing's next lines start with: the input as typed until the
 * source is declared (K9), with the typed `#ref` kept (D9).
 */
export function peekSource(
  ctx: PalmContext,
  state: ScopeState,
  input: string,
): { ref: SourceRef; declared: boolean; paste: string } {
  const found = findDeclared(ctx, state, input);
  const { known } = found;
  if (known) {
    const moved = found.ref && found.ref !== known.source.ref;
    const ref = moved ? SourceRef.of({ ...known.source, ref: found.ref as string }) : known;
    return { ref, declared: true, paste: moved ? `${known.name}#${found.ref}` : known.name };
  }
  const parsed = found.parsed as Source;
  const name = deriveSourceName(parsed, state.sources.names());
  return { ref: SourceRef.of({ ...parsed, name }), declared: false, paste: input.trim() };
}
