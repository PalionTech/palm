/**
 * Relocation (DESIGN.md section 2): every reference a hook command or an MCP server makes to
 * a file of its source (`${CLAUDE_PLUGIN_ROOT}/x`, `./scripts/y.sh`, resolved at index time as
 * `SourceReference`s) is rewritten to the entry's asset root, and the project-dir variables are
 * translated to the target's idiom.
 *
 * - `canonical` keeps placeholders intact and rewrites relative paths to `${PLUGIN_ROOT}/<rel>`
 *   (`rel` is source-relative), so it is the same for every target and every palm version: the
 *   exec hash is computed over it.
 * - `rendered` is what the harness runs: `<PROJECT>/<assetsRoot>/<rel>`, quoted, where
 *   `<PROJECT>` is the harness's project-dir idiom (`PROJECT_DIR`) at project scope and
 *   `"$HOME"` (or the override variable of a token) at global scope, never an absolute path. A
 *   reference inside double quotes gets the unquoted form, one inside single quotes closes and
 *   reopens them. A command that referenced the plugin root also exports the root variable the
 *   harness would set for a plugin (`CLAUDE_PLUGIN_ROOT`, and `CURSOR_PLUGIN_ROOT` for Cursor).
 *
 * A reference that did not resolve, or a plugin-root token no reference covers, is E_SOURCE:
 * palm never merges a command it could not resolve.
 */
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import type { McpServerConfig, Scope, SourceReference, TargetId } from '../core/types.js';
import { PLUGIN_ROOT_TOKENS, PROJECT_DIR_TOKENS } from '../domain/ignore.js';
import { homeOf, palmHomeOf } from '../domain/scope-paths.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { envRef } from '../lib/placeholders.js';

/**
 * Codex and Copilot export no project-directory variable and run hooks from the session's
 * working directory, so project hooks resolve the repository root themselves, as the Codex hook
 * docs recommend; outside a git repository the working directory stands in.
 */
const GIT_TOP_LEVEL = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)';

/**
 * How a hook command names the project root, per harness, quoted (DESIGN.md section 2):
 * `$CLAUDE_PROJECT_DIR` (claude), `$CURSOR_PROJECT_DIR` (cursor), `$GEMINI_PROJECT_DIR` (gemini)
 * and the git top level for codex and copilot. OpenCode runs no declarative hooks.
 */
export const PROJECT_DIR: Readonly<Record<TargetId, string>> = {
  claude: '"$CLAUDE_PROJECT_DIR"',
  codex: `"${GIT_TOP_LEVEL}"`,
  copilot: `"${GIT_TOP_LEVEL}"`,
  cursor: '"$CURSOR_PROJECT_DIR"',
  gemini: '"$GEMINI_PROJECT_DIR"',
  opencode: `"${GIT_TOP_LEVEL}"`,
};

/** The plugin-root variables a harness sets for a plugin's hooks, exported for relocated ones. */
const ROOT_VARS: Readonly<Record<TargetId, readonly string[]>> = {
  claude: ['CLAUDE_PLUGIN_ROOT'],
  codex: ['CLAUDE_PLUGIN_ROOT'],
  copilot: ['CLAUDE_PLUGIN_ROOT'],
  cursor: ['CURSOR_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'],
  gemini: ['CLAUDE_PLUGIN_ROOT'],
  opencode: [],
};

/** The project-dir variable each harness sets itself (kept as written). */
const OWN_PROJECT_VAR: Readonly<Partial<Record<TargetId, string>>> = {
  claude: 'CLAUDE_PROJECT_DIR',
  cursor: 'CURSOR_PROJECT_DIR',
  gemini: 'GEMINI_PROJECT_DIR',
};

export interface RelocateOptions {
  /** Lock form of the entry's asset root (`.palm/assets/<source>/<entity>`, or the in-place source dir). */
  assetsRoot: string;
  scope: Scope;
  /** Decides whether `<palm>` renders as `$HOME/.palm` or `${PALM_HOME:-$HOME/.palm}`. */
  env?: NodeJS.ProcessEnv;
  /** PowerShell commands get the paths but no POSIX `VAR=value` prefix. */
  powershell?: boolean;
}

/** `"<variable>"/<rest>` in shell: a variable expression and the path below it. */
interface ShellLocation {
  variable: string;
  rest: string;
}

type QuoteContext = 'none' | 'double' | 'single';

/** One span of a command to replace. */
interface Occurrence {
  start: number;
  end: number;
  ref?: SourceReference;
  /** Text in the canonical command. */
  canonical: string;
  /** Text in the rendered command, given the quoting at the span. */
  render: (ctx: QuoteContext) => string;
}

/** Characters that need no quoting in a path. */
const SHELL_SAFE = /^[A-Za-z0-9._/@%+=:,-]*$/;
const WORD_BEFORE = /[\s"'=(:;|&`]/;
const WORD_AFTER = /[\s"'`;|&)]/;

/** `s` escaped for a double-quoted shell string. */
function dq(s: string): string {
  return s.replace(/(["\\$`])/g, '\\$1');
}

/** The quoted idiom without its surrounding quotes. */
function bare(quoted: string): string {
  return quoted.replace(/^"(.*)"$/, '$1');
}

/** A location as shell text in quoting context `ctx`. */
function shellPath(loc: ShellLocation, ctx: QuoteContext): string {
  const tail = loc.rest ? `/${loc.rest}` : '';
  if (ctx === 'double') return `${loc.variable}${dq(tail)}`;
  const quoted = SHELL_SAFE.test(loc.rest)
    ? `"${loc.variable}"${tail}`
    : `"${loc.variable}${dq(tail)}"`;
  return ctx === 'single' ? `'${quoted}'` : quoted;
}

/** The quoting after the (unescaped) character `c`. */
function step(ctx: QuoteContext, c: string | undefined): QuoteContext {
  if (ctx === 'single') return c === "'" ? 'none' : 'single';
  if (c === '"') return ctx === 'double' ? 'none' : 'double';
  if (c === "'" && ctx === 'none') return 'single';
  return ctx;
}

/** The quoting in effect at `index` of `command` (a backslash escapes outside single quotes). */
function contextAt(command: string, index: number): QuoteContext {
  let ctx: QuoteContext = 'none';
  for (let i = 0; i < index; i++) {
    if (ctx !== 'single' && command[i] === '\\') i++;
    else ctx = step(ctx, command[i]);
  }
  return ctx;
}

/** True when `palmHome` in `env` is not the default `<home>/.palm`. */
function customPalmHome(env: NodeJS.ProcessEnv): boolean {
  if ((env.PALM_HOME ?? '') === '') return false;
  const home = homeOf(env);
  return path.resolve(palmHomeOf(env, home)) !== path.join(home, '.palm');
}

/** `${VAR:-fallback}` followed by `suffix`: a token dir that honours its override variable. */
function overrideForm(variable: string, fallback: string, suffix = ''): string {
  return `${envRef(variable, 'dollar-default', fallback)}${suffix}`;
}

/** Shell form of each global token: below `$HOME`, or its override variable when set. */
const TOKEN_SHELL: Readonly<Record<string, { home: string; override?: string; form?: string }>> = {
  home: { home: '' },
  palm: { home: '.palm', override: 'PALM_HOME', form: overrideForm('PALM_HOME', '$HOME/.palm') },
  agents: { home: '.agents' },
  claude: {
    home: '.claude',
    override: 'CLAUDE_CONFIG_DIR',
    form: overrideForm('CLAUDE_CONFIG_DIR', '$HOME/.claude'),
  },
  codex: {
    home: '.codex',
    override: 'CODEX_HOME',
    form: overrideForm('CODEX_HOME', '$HOME/.codex'),
  },
  copilot: {
    home: '.copilot',
    override: 'COPILOT_HOME',
    form: overrideForm('COPILOT_HOME', '$HOME/.copilot'),
  },
  cursor: { home: '.cursor' },
  gemini: {
    home: '.gemini',
    override: 'GEMINI_CLI_HOME',
    form: overrideForm('GEMINI_CLI_HOME', '$HOME', '/.gemini'),
  },
  opencode: {
    home: '.config/opencode',
    override: 'XDG_CONFIG_HOME',
    form: overrideForm('XDG_CONFIG_HOME', '$HOME/.config', '/opencode'),
  },
};

function overridden(token: string, env: NodeJS.ProcessEnv, name: string): boolean {
  return token === 'palm' ? customPalmHome(env) : (env[name] ?? '') !== '';
}

/** A global lock path (`<palm>/assets/x/y`) as a `$HOME`-relative shell location. */
function globalLocation(lockPath: string, env: NodeJS.ProcessEnv): ShellLocation {
  const m = /^<([a-z]+)>(?:\/(.*))?$/.exec(lockPath);
  const spec = m ? TOKEN_SHELL[m[1] as string] : undefined;
  if (!m || !spec)
    throw new PalmError('E_INTERNAL', `global asset path without a known token: ${lockPath}`);
  const rest = m[2] ?? '';
  if (spec.override && spec.form && overridden(m[1] as string, env, spec.override))
    return { variable: spec.form, rest };
  return { variable: '$HOME', rest: [spec.home, rest].filter(Boolean).join('/') };
}

/** Where the lock path `lockPath` lies, as a shell location for `target`. */
function shellLocation(lockPath: string, target: TargetId, opts: RelocateOptions): ShellLocation {
  if (opts.scope === 'global') return globalLocation(lockPath, opts.env ?? {});
  return { variable: bare(PROJECT_DIR[target]), rest: lockPath };
}

/** The lock path a resolved reference names below the asset root. */
function assetPath(assetsRoot: string, rel: string): string {
  const joined = path.posix.join(assetsRoot, rel === '' ? '.' : rel);
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

function unresolvedError(ref: SourceReference, text: string): PalmError {
  return new PalmError(
    'E_SOURCE',
    `cannot relocate "${ref.raw}" in ${JSON.stringify(text)}${ref.unresolved ? `: ${ref.unresolved}` : ''}`,
    `a command must name a file relative to its hooks.json, ${envRef('CLAUDE_PLUGIN_ROOT')}, or the project dir`,
  );
}

/** Start indexes of `raw` in `text`; relative paths only where they are whole words. */
function indexesOf(text: string, ref: SourceReference): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(ref.raw); i >= 0; i = text.indexOf(ref.raw, i + 1)) {
    const before = i === 0 || WORD_BEFORE.test(text[i - 1] as string);
    const endChar = text[i + ref.raw.length];
    const after = endChar === undefined || WORD_AFTER.test(endChar);
    if (ref.form === 'plugin-root' || (before && after)) out.push(i);
  }
  return out;
}

/** The canonical text of a reference: relative paths become `${PLUGIN_ROOT}/<rel>`. */
function canonicalOf(ref: SourceReference): string {
  return ref.form === 'relative' ? `\${PLUGIN_ROOT}/${ref.rel ?? ''}` : ref.raw;
}

function refOccurrences(
  command: string,
  refs: readonly SourceReference[],
  render: (lockPath: string, ctx: QuoteContext) => string,
  assetsRoot: string,
): Occurrence[] {
  return refs.flatMap((ref) =>
    ref.form === 'project-dir' || ref.raw === ''
      ? []
      : indexesOf(command, ref).map((start) => ({
          start,
          end: start + ref.raw.length,
          ref,
          canonical: canonicalOf(ref),
          render: (ctx: QuoteContext) => render(assetPath(assetsRoot, ref.rel ?? ''), ctx),
        })),
  );
}

/** Project-dir tokens that are not the target's own variable, translated to its idiom. */
function projectDirOccurrences(command: string, target: TargetId): Occurrence[] {
  const own = OWN_PROJECT_VAR[target];
  const idiom = { variable: bare(PROJECT_DIR[target]), rest: '' };
  return [...command.matchAll(new RegExp(PROJECT_DIR_TOKENS.source, 'g'))]
    .filter((m) => own === undefined || !m[0].includes(own))
    .map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      canonical: m[0],
      render: (ctx: QuoteContext) => shellPath(idiom, ctx),
    }));
}

/** Occurrences sorted by position, the longest first at one position, overlaps dropped. */
function disjoint(list: Occurrence[]): Occurrence[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Occurrence[] = [];
  for (const o of sorted) if (o.start >= (out.at(-1)?.end ?? 0)) out.push(o);
  return out;
}

/** `text` with each occurrence replaced by `pick(occurrence)`. */
function spliced(
  text: string,
  list: readonly Occurrence[],
  pick: (o: Occurrence) => string,
): string {
  let out = '';
  let at = 0;
  for (const o of list) {
    out += text.slice(at, o.start) + pick(o);
    at = o.end;
  }
  return out + text.slice(at);
}

/** The plugin root's source-relative path, from a reference such as `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`. */
function pluginRootRel(ref: SourceReference): string {
  const rel = ref.rel ?? '';
  const tail = ref.raw.replace(/^(\$\{[^}]*\}|\$[A-Za-z_]+)\/?/, '');
  if (tail === '' || !rel.endsWith(tail)) return rel;
  return rel.slice(0, rel.length - tail.length).replace(/\/$/, '');
}

/** `VAR=<root> ` for each plugin-root variable the harness would set; empty when none applies. */
function rootExports(list: readonly Occurrence[], target: TargetId, opts: RelocateOptions): string {
  const ref = list.find((o) => o.ref?.form === 'plugin-root')?.ref;
  if (!ref || opts.powershell) return '';
  const root = shellLocation(assetPath(opts.assetsRoot, pluginRootRel(ref)), target, opts);
  return ROOT_VARS[target].map((v) => `${v}=${shellPath(root, 'none')} `).join('');
}

function assertResolved(list: readonly Occurrence[], text: string): void {
  const bad = list.find(
    (o) => o.ref?.unresolved !== undefined || (o.ref && o.ref.rel === undefined),
  );
  if (bad?.ref) throw unresolvedError(bad.ref, text);
}

function assertNoRootLeft(rendered: string, original: string): void {
  const left = rendered.match(new RegExp(PLUGIN_ROOT_TOKENS.source));
  if (left) throw unresolvedError({ raw: left[0], form: 'plugin-root', site: 'command' }, original);
}

/**
 * One hook command relocated for `target`: `canonical` (placeholders intact, relative paths as
 * `${PLUGIN_ROOT}/<rel>`) and `rendered` (the command the harness runs). `refs` may hold every
 * reference of the hook set; only those found in `command` apply.
 */
export function relocateCommand(
  command: string,
  refs: SourceReference[],
  target: TargetId,
  opts: RelocateOptions,
): { canonical: string; rendered: string } {
  const render = (lockPath: string, ctx: QuoteContext): string =>
    shellPath(shellLocation(lockPath, target, opts), ctx);
  const own = refs.filter((r) => r.site === 'command');
  const list = disjoint([
    ...refOccurrences(command, own, render, opts.assetsRoot),
    ...projectDirOccurrences(command, target),
  ]);
  assertResolved(list, command);
  const canonical = spliced(command, list, (o) => o.canonical);
  const body = spliced(command, list, (o) => o.render(contextAt(command, o.start)));
  assertNoRootLeft(body, command);
  return { canonical, rendered: rootExports(list, target, opts) + body };
}

/** Where an MCP server finds a relocated file: a path string the harness passes as is. */
export interface McpRelocateOptions {
  assetsRoot: string;
  scope: Scope;
  /** Global scope: the absolute form of a lock path, and the home directory. */
  absolute?: (lockPath: string) => string;
  home?: string;
}

/** How each harness writes the home directory in an MCP config (Codex expands nothing). */
const MCP_HOME: Readonly<Record<TargetId, string | undefined>> = {
  claude: envRef('HOME'),
  codex: undefined,
  copilot: envRef('HOME'),
  cursor: envRef('userHome'),
  gemini: envRef('HOME'),
  opencode: '{env:HOME}',
};

/** A relocated path in an MCP field: project-relative at project scope; `$HOME`-relative globally. */
function mcpPath(lockPath: string, target: TargetId, opts: McpRelocateOptions): string {
  if (opts.scope === 'project' || !opts.absolute) return lockPath;
  const abs = opts.absolute(lockPath);
  const homeVar = MCP_HOME[target];
  if (!homeVar || !opts.home || !isWithin(abs, opts.home, { strict: true })) return abs;
  return `${homeVar}/${toPosix(path.relative(opts.home, abs))}`;
}

/** One MCP field relocated: `[canonical, rendered]`. */
function relocateField(
  value: string,
  refs: readonly SourceReference[],
  place: (lockPath: string) => string,
  assetsRoot: string,
): [string, string] {
  const list = disjoint(refOccurrences(value, refs, (p) => place(p), assetsRoot));
  assertResolved(list, value);
  const rendered = spliced(value, list, (o) => o.render('none'));
  assertNoRootLeft(rendered, value);
  return [spliced(value, list, (o) => o.canonical), rendered];
}

/** An argument vector as one display line (arguments with spaces or quotes JSON-quoted). */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/**
 * An MCP server with every source reference in `command`, `args` and `cwd` relocated for
 * `target`, plus the canonical and rendered command lines (for the exec unit).
 */
export function relocateMcp(
  cfg: McpServerConfig,
  refs: SourceReference[],
  target: TargetId,
  opts: McpRelocateOptions,
): { cfg: McpServerConfig; canonical: string; rendered: string } {
  const place = (lockPath: string): string => mcpPath(lockPath, target, opts);
  const at = (site: SourceReference['site']) => refs.filter((r) => r.site === site);
  const field = (v: string, site: SourceReference['site']) =>
    relocateField(v, at(site), place, opts.assetsRoot);
  const command = cfg.command === undefined ? undefined : field(cfg.command, 'command');
  const args = (cfg.args ?? []).map((a) => field(a, 'args'));
  const cwd = cfg.cwd === undefined ? undefined : field(cfg.cwd, 'cwd');
  const out: McpServerConfig = { ...cfg };
  if (command) out.command = command[1];
  if (cfg.args) out.args = args.map((a) => a[1]);
  if (cwd) out.cwd = cwd[1];
  const argv = (i: 0 | 1) => [...(command ? [command[i]] : []), ...args.map((a) => a[i])];
  return { cfg: out, canonical: commandLine(argv(0)), rendered: commandLine(argv(1)) };
}
