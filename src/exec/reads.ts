/**
 * What the scripts of a closure read (rulings E1, E1', Sofia S3, O10): one level of static
 * analysis over each script body, so a hook that reads `../skills/x/SKILL.md` carries that file
 * with it and the consent prompt lists it under `reads:`. Recognised forms:
 *
 * - a plugin-root token followed by a path: `${CLAUDE_PLUGIN_ROOT}/skills/x/SKILL.md`;
 * - the script's own directory followed by a path: `$(dirname "$0")/../x`,
 *   `${BASH_SOURCE[0]%/*}/x`, `$(cd "$(dirname "$0")/.." && pwd)/x`, and a variable assigned
 *   from one of those (`SCRIPT_DIR=…`, then `"${SCRIPT_DIR}/plugin.json"`), quoted or not;
 * - the project directory followed by a path: `"$CLAUDE_PROJECT_DIR/tools/x"`,
 *   `$(git rev-parse --show-toplevel)/x`;
 * - a literal relative path from the script's directory (`./lib.sh`, `../x`), counted when it
 *   names something in the source.
 *
 * A file the scripts read is kept even when the copy rules would leave it out (`plugin.json`,
 * a SKILL.md). For an in-place (in-repo) source, a read that leaves the source but stays inside
 * the worktree, and a project file a hook command runs (`go run .agents/hooks/main.go`), are
 * hashed in place like the rest (`worktree`). Any other read palm cannot place is reported (a
 * warning at install and in the consent review), never copied. Scripts are read, never run.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Closure, Entity } from '../core/types.js';
import { isClosureExcluded, PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
import { walkFiles } from '../lib/fs.js';
import { commandReads } from './reads-command.js';
import { type Placing, PROJECT_MARK, placeRead, type UnresolvedRead } from './reads-place.js';

export interface ClosureReads {
  /** Source-relative files and directories the scripts read, outside the closure paths, sorted. */
  reads: string[];
  unresolved: UnresolvedRead[];
}

/** How far reads may reach: for an in-place source, the worktree its files are hashed in. */
export interface ReadOptions {
  /** Absolute worktree root (in-place sources only); reads inside it are hashed in place. */
  worktree?: string;
}

/** Script bodies larger than this are not analysed. */
const MAX_SCRIPT_BYTES = 256 * 1024;
const OPEN = '\u0001';
const CLOSE = '\u0002';
const SEGMENTS = '((?:/[A-Za-z0-9._@+-]+)+)';
const SCRIPT_REF = String.raw`"?\$(?:0|\{0\}|BASH_SOURCE|\{BASH_SOURCE(?:\[0\])?(?::-\$0)?\})"?`;
const DIRNAME = new RegExp(String.raw`\$\(\s*dirname\s+(?:--\s+)?${SCRIPT_REF}\s*\)`, 'g');
const DIRNAME_TICKS = new RegExp(String.raw`\`\s*dirname\s+(?:--\s+)?${SCRIPT_REF}\s*\``, 'g');
const STRIP_SUFFIX = /\$\{(?:0|BASH_SOURCE(?:\[0\])?)%\/\*\}/g;
const PROJECT_DIR =
  /\$\{(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}|\$(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\b|\$\(\s*git rev-parse --show-toplevel[^)]*\)/g;
const CD_PWD = new RegExp(
  String.raw`\$\(\s*cd\s+(?:-P\s+)?(?:--\s+)?"?${OPEN}([^${CLOSE}]*)${CLOSE}"?((?:/[A-Za-z0-9._@+-]+)*)"?\s*(?:&?>\s*/dev/null\s*)?(?:2>&1\s*)?&&\s*pwd(?:\s+-P)?\s*\)`,
  'g',
);
const ASSIGN = new RegExp(
  String.raw`^\s*(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=("?)${OPEN}([^${CLOSE}]*)${CLOSE}((?:/[A-Za-z0-9._@+-]+)*)\2\s*(?:[;#].*)?$`,
);
const MARKED = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}"?${SEGMENTS}`, 'g');
const RELATIVE = /(?<![\w$/.:~-])(\.\.?(?:\/[A-Za-z0-9._@+-]+)+)/g;

function mark(rel: string): string {
  return `${OPEN}${rel}${CLOSE}`;
}

/** `dir` joined with `tail`, normalised; `..` at the front when it leaves the source. */
function joinRel(dir: string, tail: string): string {
  if (dir.startsWith(PROJECT_MARK)) return `${PROJECT_MARK}${joinRel(dir.slice(1), tail)}`;
  const joined = posix.normalize(posix.join(dir || '.', tail));
  return joined === '.' ? '' : joined.replace(/\/$/, '');
}

/** `$(cd "<marked dir>/.." && pwd)` → a marker of the directory it names. */
function markCd(text: string): string {
  return text.replace(CD_PWD, (_m, dir: string, tail: string) => mark(joinRel(dir, `.${tail}`)));
}

/** `text` with every directory expression of the script replaced by a marker of the directory it names. */
function markDirectories(text: string, scriptDir: string): string {
  const own = mark(scriptDir);
  const marked = text
    .replace(DIRNAME, own)
    .replace(DIRNAME_TICKS, own)
    .replace(STRIP_SUFFIX, own)
    .replace(PROJECT_DIR, mark(PROJECT_MARK));
  return markCd(marked);
}

/** Variables assigned a marked directory (`SCRIPT_DIR="$(cd … && pwd)"`), substituted where used. */
function markVariables(lines: string[]): string[] {
  let out = lines;
  for (let round = 0; round < 3; round++) {
    const vars = new Map<string, string>();
    for (const line of out) {
      const m = ASSIGN.exec(line);
      if (m?.[1]) vars.set(m[1], joinRel(m[3] ?? '', `.${m[4] ?? ''}`));
    }
    if (!vars.size) return out;
    const names = [...vars.keys()].join('|');
    const use = new RegExp(String.raw`\$\{(${names})\}|\$(${names})\b`, 'g');
    const next = out.map((l) =>
      l.replace(use, (_m, a?: string, b?: string) => mark(vars.get(a ?? b ?? '') ?? '')),
    );
    if (next.every((l, i) => l === out[i])) return next;
    out = next.map(markCd);
  }
  return out;
}

async function addMarked(job: Placing, text: string): Promise<void> {
  for (const [, dir = '', tail = ''] of text.matchAll(MARKED))
    await placeRead(job, joinRel(dir, `.${tail}`), { strict: true });
}

async function addRelative(job: Placing, text: string): Promise<void> {
  const dir = posix.dirname(job.script);
  for (const [, path = ''] of text.matchAll(RELATIVE))
    await placeRead(job, joinRel(dir === '.' ? '' : dir, path), { strict: false });
}

/** The script's text without comment lines, with plugin-root tokens and directory forms marked. */
function prepared(body: string, script: string, pluginRoot: string): string {
  const scriptDir = posix.dirname(script) === '.' ? '' : posix.dirname(script);
  const lines = body
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => markDirectories(l, scriptDir));
  return markVariables(lines)
    .map((l) => l.replace(PLUGIN_ROOT_TOKENS, mark(pluginRoot)))
    .join('\n');
}

async function scriptText(abs: string): Promise<string | undefined> {
  const data = await readFile(abs).catch(() => undefined);
  if (!data || data.length > MAX_SCRIPT_BYTES || data.subarray(0, 8192).includes(0))
    return undefined;
  return data.toString('utf8');
}

/** Source-relative files below the closure paths (a directory swallows its files). */
async function scriptsOf(sourceRoot: string, closure: Closure): Promise<string[]> {
  const out: string[] = [];
  for (const p of closure.paths) {
    const abs = join(sourceRoot, ...p.split('/'));
    const st = await stat(abs).catch(() => undefined);
    if (st?.isFile()) out.push(p);
    else if (st?.isDirectory())
      out.push(
        ...(await walkFiles(abs, { boundary: sourceRoot })).files.map((f) => `${p}/${f.rel}`),
      );
  }
  return out;
}

/**
 * True when the closure paths hold `rel` already and the copy keeps it: a file the copy rules
 * leave out (`plugin.json`, a SKILL.md) stays a read even inside a closure directory (E1').
 */
function covered(closure: Closure, rel: string): boolean {
  if (isClosureExcluded(rel)) return closure.paths.includes(rel);
  return closure.paths.some((p) => rel === p || rel.startsWith(`${p.replace(/\/$/, '')}/`));
}

/**
 * The files and directories the closure's scripts read outside the closure paths, and the
 * reads palm could not follow. `pluginRootRel` is what a plugin-root token stands for.
 */
export async function closureReads(
  sourceRoot: string,
  closure: Closure,
  pluginRootRel: string,
  opts: ReadOptions = {},
): Promise<ClosureReads> {
  const found: ClosureReads = { reads: [], unresolved: [] };
  for (const script of await scriptsOf(sourceRoot, closure)) {
    const body = await scriptText(join(sourceRoot, ...script.split('/')));
    if (body === undefined) continue;
    const job: Placing = { sourceRoot, script, found, ...opts };
    const text = prepared(body, script, pluginRootRel);
    await addMarked(job, text);
    await addRelative(job, text);
  }
  const reads = [...new Set(found.reads)].filter((r) => r !== '' && !covered(closure, r)).sort();
  return { reads, unresolved: found.unresolved };
}

/** The closure and plugin root of a hook set or MCP server; undefined for other kinds. */
function closureOf(entity: Entity): { closure: Closure; pluginRoot: string } | undefined {
  const { def } = entity;
  if (def.kind === 'hook')
    return {
      closure: def.hooks.closure,
      pluginRoot: def.hooks.pluginRootRel ?? posix.dirname(entity.path),
    };
  if (def.kind === 'mcp') return { closure: def.closure, pluginRoot: posix.dirname(entity.path) };
  return undefined;
}

function withClosure(entity: Entity, closure: Closure): Entity {
  const { def } = entity;
  if (def.kind === 'hook') return { ...entity, def: { ...def, hooks: { ...def.hooks, closure } } };
  if (def.kind === 'mcp') return { ...entity, def: { ...def, closure } };
  return entity;
}

/** `hook session-start: hooks/run.sh reads ../x, outside the source; palm does not copy it`. */
function unresolvedLine(entity: Entity, u: UnresolvedRead, inPlace: boolean): string {
  const verb = u.runs ? 'runs' : 'reads';
  const tail = inPlace ? 'palm does not hash it' : 'palm does not copy it';
  return `${entity.kind} ${entity.name}: ${u.script} ${verb} ${u.raw}, ${u.why}; ${tail}`;
}

/**
 * `entity` with the files its scripts read added to its closure (`paths` and `reads`), and one
 * warning line per read palm could not follow (the engine prints them and shows them in the
 * consent review). For an in-place source, `worktree` lets reads outside the source but inside
 * the worktree, and project files its commands run (O10), join the in-place hash. Kinds without
 * a closure come back as they are.
 */
export async function withScriptReads(
  entity: Entity,
  sourceRoot: string,
  opts: ReadOptions = {},
): Promise<{ entity: Entity; warnings: string[] }> {
  const at = closureOf(entity);
  const found = at?.closure.paths.length
    ? await closureReads(sourceRoot, at.closure, at.pluginRoot, opts)
    : { reads: [], unresolved: [] };
  if (at && opts.worktree !== undefined)
    await commandReads(entity, { sourceRoot, worktree: opts.worktree, found });
  const inPlace = opts.worktree !== undefined;
  const warnings = found.unresolved.map((u) => unresolvedLine(entity, u, inPlace));
  if (!at) return { entity, warnings };
  const reads = [...new Set(found.reads)].filter((r) => r !== '' && !covered(at.closure, r));
  if (!reads.length) return { entity, warnings };
  const paths = [...new Set([...at.closure.paths, ...reads])].sort();
  return { entity: withClosure(entity, { ...at.closure, paths, reads: reads.sort() }), warnings };
}
