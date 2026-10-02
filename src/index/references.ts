/**
 * Relocation (DESIGN §2 "Relocation and the asset closure"): every reference a hook command or an
 * MCP server's command, args and cwd makes to a file of the source, resolved at index time, and
 * the closure a deploy copies.
 *
 * Recognised forms: a plugin-root token (`PLUGIN_ROOT_TOKENS`: `${CLAUDE_PLUGIN_ROOT}` and its
 * variants, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, `${extensionPath}`) followed by a path; a
 * relative path (`./x` must exist, `x/y` or a bare file name counts when it names something in
 * the source); a project-dir variable (`PROJECT_DIR_TOKENS`), recorded for translation. What
 * cannot be resolved before the hook runs (`eval`, `$(…)`, backticks, `~/…`, `$HOME/…`, a
 * missing file, a path or link leaving the source) is recorded as `unresolved`.
 *
 * `raw` is the path as written in the line, quotes included, so it is an exact substring of the
 * command, argument or cwd it came from.
 */

import type { Closure, EntityIssue, ReferenceSite, SourceReference } from '../core/types.js';
import { isClosureExcluded, PLUGIN_ROOT_TOKENS, PROJECT_DIR_TOKENS } from '../domain/ignore.js';
import { isRecord } from '../lib/object.js';
import type { FileIndex } from './files.js';
import { hookHandlers } from './hooks.js';
import { type ShellLine, scanShell, unquote } from './shell-words.js';
import { displayRel, escapesRoot, joinRel, normRel } from './util.js';

export interface ReferenceOptions {
  /** Directory of the hooks (or MCP config) file, source-relative. */
  hooksDirRel: string;
  /** The plugin root; absent for APM layouts, whose relative paths start at the hooks directory. */
  pluginRootRel?: string;
  files: FileIndex;
}

/** A reference and the line it was found in (the offending line of an unresolved one). */
export interface FoundReference {
  ref: SourceReference;
  line: string;
}

interface Bases {
  /** What a plugin-root token stands for. */
  root: string;
  /** What a relative path starts at. */
  relative: string;
  files: FileIndex;
}

/** One place a reference can hide: `shell` lines are split and checked for eval and `$(…)`. */
interface Line {
  text: string;
  site: ReferenceSite;
  mode: 'shell' | 'words' | 'word';
}

const PLUGIN_ROOT_RE = new RegExp(PLUGIN_ROOT_TOKENS.source);
const PROJECT_DIR_RE = new RegExp(PROJECT_DIR_TOKENS.source);
const BARE_PLUGIN_ROOT_RE = new RegExp(`^(?:${PLUGIN_ROOT_TOKENS.source})/?$`);
const EXPLICIT_RELATIVE_RE = /^\.\.?\//;
const HOME_RE = /^(?:~|\$HOME\b|\$\{HOME\})(?:\/|$)/;
const ASSIGNMENT_RE = /^(?:--?[A-Za-z0-9][\w.-]*|[A-Za-z_]\w*)=/;

const REASONS = {
  eval: 'eval runs text that is only known when the hook runs',
  substitution: 'a command substitution is only known when the hook runs',
  home: 'names a path in the home directory, outside the source',
  outside: 'points outside the source',
  link: 'is a link that leaves the source',
} as const;

function basesOf(opts: ReferenceOptions): Bases {
  const plugin = opts.pluginRootRel === undefined ? undefined : normRel(opts.pluginRootRel);
  return { root: plugin ?? '', relative: plugin ?? normRel(opts.hooksDirRel), files: opts.files };
}

const stringOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

function hookLines(raw: unknown): Line[] {
  const lines: Line[] = [];
  for (const { handler } of hookHandlers(raw)) {
    if (handler.type === 'prompt') continue;
    for (const key of ['command', 'bash', 'powershell']) {
      const text = stringOf(handler[key]);
      if (text) lines.push({ text, site: 'command', mode: 'shell' });
    }
    const cwd = stringOf(handler.cwd);
    if (cwd) lines.push({ text: cwd, site: 'cwd', mode: 'word' });
  }
  return lines;
}

/** MCP servers are started without a shell: args are single words, `$(…)` stays literal. */
function mcpLines(raw: unknown): Line[] {
  if (!isRecord(raw)) return [];
  const lines: Line[] = [];
  const command = stringOf(raw.command);
  if (command) lines.push({ text: command, site: 'command', mode: 'words' });
  for (const arg of Array.isArray(raw.args) ? raw.args : []) {
    const text = stringOf(arg);
    if (text) lines.push({ text, site: 'args', mode: 'word' });
  }
  const cwd = stringOf(raw.cwd);
  if (cwd) lines.push({ text: cwd, site: 'cwd', mode: 'word' });
  return lines;
}

function unresolved(raw: string, site: ReferenceSite, reason: string): SourceReference {
  return { raw, form: 'relative', site, unresolved: reason };
}

function missingReason(base: string): string {
  return base === '' ? 'no such file in the source' : `no such file under ${base}/`;
}

/** A path that must exist: resolved, or unresolved with the reason. */
function mustResolve(
  ref: Pick<SourceReference, 'raw' | 'form' | 'site'>,
  rel: string,
  b: Bases,
  base: string,
): SourceReference {
  if (escapesRoot(rel)) return { ...ref, unresolved: REASONS.outside };
  const kind = b.files.locate(rel);
  if (kind === 'outside') return { ...ref, unresolved: REASONS.link };
  if (kind === undefined) return { ...ref, unresolved: missingReason(base) };
  return { ...ref, rel: displayRel(rel) };
}

/** From the token (and an opening quote right before it) to the end of the word. */
function rawFrom(text: string, index: number): string {
  const before = text[index - 1];
  return text.slice(index > 0 && (before === '"' || before === "'") ? index - 1 : index);
}

function tokenReference(text: string, site: ReferenceSite, b: Bases): SourceReference | undefined {
  const plugin = PLUGIN_ROOT_RE.exec(text);
  if (plugin) {
    const raw = rawFrom(text, plugin.index);
    const value = unquote(raw);
    const rest = value.slice(value.indexOf(plugin[0]) + plugin[0].length).replace(/^\/+/, '');
    return mustResolve({ raw, form: 'plugin-root', site }, joinRel(b.root, rest), b, b.root);
  }
  const project = PROJECT_DIR_RE.exec(text);
  if (project) return { raw: rawFrom(text, project.index), form: 'project-dir', site };
  return undefined;
}

/** Could name a file of the source: not an option, variable, URL, absolute path or scope. */
function isPathCandidate(value: string): boolean {
  if (value === '' || value === '.' || value === './' || /\s/.test(value)) return false;
  return !/^[-$/@%{]/.test(value) && !value.includes('://') && !value.includes('$');
}

function pathReference(text: string, site: ReferenceSite, b: Bases): SourceReference | undefined {
  const value = unquote(text);
  if (HOME_RE.test(value)) return unresolved(text, site, REASONS.home);
  const rel = joinRel(b.relative, value);
  const ref = { raw: text, form: 'relative' as const, site };
  if (EXPLICIT_RELATIVE_RE.test(value)) return mustResolve(ref, rel, b, b.relative);
  if (!isPathCandidate(value) || escapesRoot(rel)) return undefined;
  const kind = b.files.locate(rel);
  const named = kind === 'file' || (kind === 'dir' && value.includes('/'));
  return named ? { ...ref, rel: displayRel(rel) } : undefined;
}

function wordReference(word: string, site: ReferenceSite, b: Bases): SourceReference | undefined {
  const assignment = ASSIGNMENT_RE.exec(word);
  const text = assignment ? word.slice(assignment[0].length) : word;
  return tokenReference(text, site, b) ?? pathReference(text, site, b);
}

/** eval and command substitutions: nothing palm can resolve before the hook runs. */
function shellHazards(scan: ShellLine, site: ReferenceSite): SourceReference[] {
  const refs = scan.substitutions.map((raw) => unresolved(raw, site, REASONS.substitution));
  for (const w of scan.words) {
    if (w.commandPosition && unquote(w.text) === 'eval')
      refs.push(unresolved(w.text, site, REASONS.eval));
  }
  return refs;
}

function referencesInLine(line: Line, b: Bases): SourceReference[] {
  if (line.mode === 'word') {
    const ref = wordReference(line.text, line.site, b);
    return ref ? [ref] : [];
  }
  const scan = scanShell(line.text);
  const refs = line.mode === 'shell' ? shellHazards(scan, line.site) : [];
  for (const w of scan.words) {
    const ref = w.substituted ? undefined : wordReference(w.text, line.site, b);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** Every reference with its line, once per (site, raw), in the order found. */
export function collectReferences(
  raw: unknown,
  site: 'hook' | 'mcp',
  opts: ReferenceOptions,
): FoundReference[] {
  const b = basesOf(opts);
  const seen = new Set<string>();
  const out: FoundReference[] = [];
  for (const line of site === 'hook' ? hookLines(raw) : mcpLines(raw)) {
    for (const ref of referencesInLine(line, b)) {
      const key = `${ref.site}\0${ref.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, line: line.text });
    }
  }
  return out;
}

/** Every plugin-root, relative and project-dir reference, resolved against the source. */
export function findReferences(
  raw: unknown,
  site: 'hook' | 'mcp',
  opts: ReferenceOptions,
): SourceReference[] {
  return collectReferences(raw, site, opts).map((f) => f.ref);
}

/** One critical issue per unresolved reference, naming the file, the reference and its line. */
export function unresolvedIssues(found: FoundReference[], file: string): EntityIssue[] {
  return found
    .filter((f) => f.ref.unresolved !== undefined)
    .map(({ ref, line }) => ({
      code: 'unresolvable-reference' as const,
      severity: 'critical' as const,
      message: `${file}: cannot relocate ${JSON.stringify(ref.raw)} in ${ref.site} ${JSON.stringify(line)}: ${ref.unresolved}`,
      file,
    }));
}

/** A bare plugin-root token names the base, not a file: it adds nothing to the closure. */
function namesBase(ref: SourceReference): boolean {
  return ref.form === 'plugin-root' && BARE_PLUGIN_ROOT_RE.test(unquote(ref.raw));
}

/**
 * Sorted, deduplicated closure paths: the root, missing paths and `CLOSURE_NEVER` entries left
 * out, and a path below another listed directory swallowed by it.
 */
export function normalizeClosure(candidates: readonly string[], files: FileIndex): string[] {
  const kept = [...new Set(candidates.map(normRel))]
    .filter((p) => p !== '' && !escapesRoot(p) && !isClosureExcluded(p))
    .filter((p) => {
      const kind = files.locate(p);
      return kind === 'file' || kind === 'dir';
    })
    .sort();
  return kept.filter((p) => !kept.some((q) => p.startsWith(`${q}/`)));
}

/** The source paths the resolved references name (a bare plugin root names none). */
export function namedPaths(refs: readonly SourceReference[]): string[] {
  return refs.flatMap((r) => (r.rel !== undefined && !namesBase(r) ? [r.rel] : []));
}

/** The hooks file's directory plus every resolved path, at the level each reference names. */
export function closureOf(
  refs: SourceReference[],
  opts: { hooksDirRel?: string; files: FileIndex },
): Closure {
  return { paths: normalizeClosure([opts.hooksDirRel ?? '', ...namedPaths(refs)], opts.files) };
}
