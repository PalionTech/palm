/**
 * The checks about where generated files live (DESIGN §6 "Check"): `links`, and the warnings
 * `double-load`, `agent-names` and `block-size` (`git-ignored` is in check-git.ts). `links`
 * walks the output directories for dangling links and links leaving the scope (Z5).
 */
import { existsSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import type { CheckRun, LockEntry } from '../core/types.js';
import { walkFiles } from '../lib/fs.js';
import { BLOCK_CAPS, blockSizeProblem } from './block-size.js';
import { type CheckContext, checkRun, count, entityOf, type Found, found } from './check-kit.js';
import { scopesTwice } from './check-scopes.js';
import { findOverlaps, overlapMessage } from './scope.js';

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

async function isDangling(abs: string): Promise<boolean> {
  const isLink = await lstat(abs).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  return (
    isLink &&
    !(await stat(abs).then(
      () => true,
      () => false,
    ))
  );
}

async function linkProblem(c: CheckContext, e: LockEntry, file: string) {
  const { paths } = c.run.state;
  const abs = paths.abs(file);
  const { real, inside } = await paths.realInside(abs);
  const fix = `remove the link at ${file}, then palm install`;
  if (!inside)
    return {
      entity: entityOf(e),
      file,
      message: `${file} resolves to ${real}, outside the scope`,
      fix,
    };
  if (await isDangling(abs))
    return { entity: entityOf(e), file, message: `${file} is a dangling link`, fix };
  return undefined;
}

/** The project's output directories that exist (lock form). */
function outputDirs(c: CheckContext): string[] {
  const { ctx, deps, state } = c.run;
  const { paths } = state;
  const dirs = new Set(
    state.targets.flatMap((t) => deps.getTarget(t).outputDirs(paths.scope, paths.root, ctx.env)),
  );
  return [...dirs].filter((d) => existsSync(paths.abs(d)));
}

/** Links below `dir` that dangle or leave the project: `[file, why]`. */
async function badLinks(c: CheckContext, dir: string): Promise<Array<[string, string]>> {
  const { paths } = c.run.state;
  const walk = await walkFiles(paths.abs(dir), { boundary: paths.root });
  const outside = new Set(walk.symlinksOutside);
  const out: Array<[string, string]> = [];
  for (const rel of walk.skipped) {
    const file = rel === '.' ? dir : `${dir}/${rel}`;
    if (outside.has(rel)) out.push([file, `${file} links outside the project`]);
    else if (await isDangling(paths.abs(file))) out.push([file, `${file} is a dangling link`]);
  }
  return out;
}

/** Z5: dangling links and links leaving the project anywhere under the project's output directories. */
async function outputLinks(c: CheckContext, f: Found, reported: Set<string>): Promise<void> {
  if (c.run.state.paths.scope !== 'project') return;
  for (const dir of outputDirs(c))
    for (const [file, message] of await badLinks(c, dir))
      if (!reported.has(file))
        f.fail.push({ file, message, fix: `remove the link at ${file}, then palm install` });
}

/** Output paths stay inside the scope; no dangling link; no source overlaps an output directory. */
export async function links(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const reported = new Set<string>();
  for (const e of c.run.state.lock.entries)
    for (const file of e.files) {
      const p = await linkProblem(c, e, file);
      if (p) {
        f.fail.push(p);
        reported.add(file);
      }
    }
  await outputLinks(c, f, reported);
  for (const o of await findOverlaps(c.run.ctx, c.run.state, c.run.deps))
    f.fail.push({
      message: overlapMessage(o),
      fix: 'move the source files to a directory of their own (for example ./agent-kit) and declare that in palm.yaml',
    });
  return checkRun(
    'links',
    { ok: 'no link leaves the scope', bad: (n) => `${count(n, 'link problem')}` },
    f,
  );
}

// ---------------------------------------------------------------------------
// double-load
// ---------------------------------------------------------------------------

const CARRIER_FIX =
  'palm 0.3 picks one carrier per harness; until then narrow the entry with targets: in palm.yaml';

/**
 * E8 B23: Cursor reads AGENTS.md and `.cursor/rules`, so an instruction palm wrote to both is
 * loaded twice. Skills are not: Cursor reads `.claude/skills` and `.agents/skills` and keeps one
 * per name, the carrier fact the render uses too.
 */
function instructionsTwice(c: CheckContext, f: Found): void {
  const { state } = c.run;
  if (state.paths.scope !== 'project' || !state.targets.includes('cursor')) return;
  for (const e of state.lock.entries) {
    const inBlock = (e.merged ?? []).some((m) => m.file === 'AGENTS.md');
    const inRules = e.files.some((p) => p.startsWith('.cursor/rules/'));
    if (e.kind === 'instruction' && inBlock && inRules)
      f.warn.push({
        entity: entityOf(e),
        message: `cursor loads instruction ${e.name} twice (AGENTS.md and .cursor/rules)`,
        fix: CARRIER_FIX,
      });
  }
}

/** `a and b`, `a, b and c`. */
function andList(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The lock entry that owns `file`, when palm wrote it. */
function ownerOf(c: CheckContext, file: string): LockEntry | undefined {
  return c.run.state.lock.entries.find((e) => e.kind === 'agent' && e.files.includes(file));
}

/**
 * Y14: agent files with one name in a harness's agents directory (the harness keeps one), as the
 * target reads names (`Target.agentNameClashes`: frontmatter, TOML or file stem). palm's own
 * files come first and carry their entry.
 */
async function agentsTwice(c: CheckContext, f: Found): Promise<void> {
  const { ctx, deps, state } = c.run;
  const seen = new Set<string>();
  for (const t of state.targets) {
    const clashes = await deps
      .getTarget(t)
      .agentNameClashes?.(state.paths.scope, state.paths.root, ctx.env);
    for (const clash of clashes ?? []) {
      const key = clash.files.join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      const files = [...clash.files].sort(
        (x, y) => Number(!ownerOf(c, x)) - Number(!ownerOf(c, y)),
      );
      const [first = '', ...rest] = files;
      const owner = ownerOf(c, first);
      const dir = posix.dirname(first);
      const two = files.length === 2 ? 'two' : `${files.length}`;
      f.warn.push({
        ...(owner ? { entity: entityOf(owner) } : {}),
        file: first,
        message: `${dir}/ holds ${two} agents named ${clash.name}: ${andList(files)}`,
        fix: `rename or remove ${andList(rest)}, or narrow the entry with targets: in palm.yaml`,
      });
    }
  }
}

/** A harness that would load one entity twice. */
export async function doubleLoad(c: CheckContext): Promise<CheckRun> {
  const f = found();
  instructionsTwice(c, f);
  await scopesTwice(c, f);
  return checkRun(
    'double-load',
    {
      ok: 'no harness loads an entity twice',
      bad: (n) => `${count(n, 'entity', 'entities')} loaded twice`,
    },
    f,
  );
}

/** Y14: agent files with one name in a harness's agents folder (warning). */
export async function agentNames(c: CheckContext): Promise<CheckRun> {
  const f = found();
  await agentsTwice(c, f);
  return checkRun(
    'agent-names',
    {
      ok: 'no two agents share a name in a harness folder',
      bad: (n) => `${count(n, 'agent name')} used twice in a harness folder`,
    },
    f,
  );
}

// ---------------------------------------------------------------------------
// block-size
// ---------------------------------------------------------------------------

/** A root AGENTS.md or GEMINI.md palm writes blocks into, above 24 KiB (fail above the harness cap). */
export async function blockSize(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { paths, lock } = c.run.state;
  const files = new Set(
    lock.entries
      .flatMap((e) => (e.merged ?? []).map((m) => m.file))
      .filter((p) => basename(p) in BLOCK_CAPS),
  );
  for (const file of files) {
    const size = await stat(paths.abs(file)).then(
      (s) => s.size,
      () => 0,
    );
    const p = blockSizeProblem(file, size);
    if (p) (p.level === 'fail' ? f.fail : f.warn).push({ file, message: p.message, fix: p.fix });
  }
  return checkRun(
    'block-size',
    {
      ok: 'instruction files are within harness limits',
      bad: (n) => `${count(n, 'instruction file')} too large`,
    },
    f,
  );
}
