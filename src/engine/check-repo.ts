/**
 * The checks about where generated files live (DESIGN §6 "Check"): `git-ignored`, `links`,
 * and the warnings `double-load` and `block-size`.
 */
import { existsSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import type { CheckRun, LockEntry } from '../core/types.js';
import { isGitIgnored } from '../lib/fs.js';
import { type CheckContext, checkRun, count, entityOf, found, skipped } from './check-kit.js';
import { findOverlaps } from './scope.js';

/** No output directory (or `.palm/assets`) is ignored by git: teammates would not receive it. */
export async function gitIgnored(c: CheckContext): Promise<CheckRun> {
  const { ctx, deps, state } = c.run;
  if (!c.git) return skipped('git-ignored', 'output directories committed');
  const f = found();
  const dirs = new Set([state.paths.lockForm(state.paths.assetsDir)]);
  for (const t of state.targets)
    for (const d of deps.getTarget(t).outputDirs(state.paths.scope, state.paths.root, ctx.env))
      dirs.add(d);
  for (const dir of dirs) {
    const abs = state.paths.abs(dir);
    if (!existsSync(abs)) continue;
    if (await isGitIgnored(abs, state.paths.root))
      f.fail.push({
        file: dir,
        message: `${dir}/ is ignored by git, so teammates will not receive its files`,
        fix: `edit .gitignore: stop ignoring ${dir}/`,
      });
  }
  return checkRun(
    'git-ignored',
    {
      ok: 'output directories are committed',
      bad: (n) => `${count(n, 'output directory')} ignored by git`,
    },
    f,
  );
}

async function linkProblem(c: CheckContext, e: LockEntry, file: string) {
  const { paths } = c.run.state;
  const abs = paths.abs(file);
  const { real, inside } = await paths.realInside(abs);
  if (!inside)
    return {
      entity: entityOf(e),
      file,
      message: `${file} resolves to ${real}, outside the scope`,
      fix: `remove the link at ${file}, then palm install`,
    };
  const isLink = await lstat(abs).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  const dangling =
    isLink &&
    !(await stat(abs).then(
      () => true,
      () => false,
    ));
  return dangling
    ? {
        entity: entityOf(e),
        file,
        message: `${file} is a dangling link`,
        fix: `remove the link at ${file}, then palm install`,
      }
    : undefined;
}

/** Output paths stay inside the scope; no dangling link; no source overlaps an output directory. */
export async function links(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const e of c.run.state.lock.entries)
    for (const file of e.files) {
      const p = await linkProblem(c, e, file);
      if (p) f.fail.push(p);
    }
  for (const o of await findOverlaps(c.run.ctx, c.run.state, c.run.deps))
    f.fail.push({
      message: `source "${o.source}" (${o.sourceRel}) overlaps the ${o.target === 'palm' ? 'palm asset' : o.target} directory ${o.dir}/`,
      fix: 'move the source files to a directory of their own (for example ./agent-kit) and declare that in palm.yaml',
    });
  return checkRun(
    'links',
    { ok: 'no link leaves the scope', bad: (n) => `${count(n, 'link problem')}` },
    f,
  );
}

const CARRIER_FIX =
  'palm 0.3 picks one carrier per harness; until then narrow the entry with targets: in palm.yaml';

/** A harness that would load one entity twice (Cursor reads .claude/skills, .agents/skills and AGENTS.md). */
export function doubleLoad(c: CheckContext): CheckRun {
  const f = found();
  const { state } = c.run;
  if (state.paths.scope !== 'project' || !state.targets.includes('cursor'))
    return checkRun('double-load', { ok: 'no harness loads an entity twice', bad: () => '' }, f);
  for (const e of state.lock.entries) {
    const inClaude = e.files.some((p) => p.startsWith(`.claude/skills/${e.name}/`));
    const inAgents = e.files.some((p) => p.startsWith(`.agents/skills/${e.name}/`));
    if (e.kind === 'skill' && inClaude && inAgents)
      f.warn.push({
        entity: entityOf(e),
        message: `cursor loads skill ${e.name} twice (.claude/skills and .agents/skills)`,
        fix: CARRIER_FIX,
      });
    const inBlock = (e.merged ?? []).some((m) => m.file === 'AGENTS.md');
    const inRules = e.files.some((p) => p.startsWith('.cursor/rules/'));
    if (e.kind === 'instruction' && inBlock && inRules)
      f.warn.push({
        entity: entityOf(e),
        message: `cursor loads instruction ${e.name} twice (AGENTS.md and .cursor/rules)`,
        fix: CARRIER_FIX,
      });
  }
  return checkRun(
    'double-load',
    { ok: 'no harness loads an entity twice', bad: (n) => `${count(n, 'entity')} loaded twice` },
    f,
  );
}

const WARN_BYTES = 24 * 1024;
/** Codex reads at most 32 KiB of AGENTS.md (`project_doc_max_bytes`). */
const CAPS: Record<string, number | undefined> = { 'AGENTS.md': 32 * 1024, 'GEMINI.md': undefined };

/** A root AGENTS.md or GEMINI.md palm writes blocks into, above 24 KiB (fail above the harness cap). */
export async function blockSize(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { paths, lock } = c.run.state;
  const files = new Set(
    lock.entries.flatMap((e) => (e.merged ?? []).map((m) => m.file)).filter((p) => p in CAPS),
  );
  for (const file of files) {
    const size = await stat(paths.abs(file)).then(
      (s) => s.size,
      () => 0,
    );
    const cap = CAPS[file];
    const problem = {
      file,
      message: `${file} is ${Math.round(size / 1024)} KiB`,
      fix: 'move entries with at: (palm 0.3)',
    };
    if (cap !== undefined && size > cap)
      f.fail.push({
        ...problem,
        message: `${problem.message}, above the ${cap / 1024} KiB the harness reads`,
      });
    else if (size > WARN_BYTES) f.warn.push(problem);
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
