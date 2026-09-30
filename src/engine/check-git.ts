/**
 * `git-ignored` (DESIGN §6 "Check"): every file palm wrote or merged into is committed. git is
 * asked about each file, not directories (B5 C8 Z5), at its real path, so a file behind a
 * committed link (`.claude/skills -> ../.agents/skills`) counts as the file git holds (X5 T8).
 * Ignored is a failure (teammates will not receive it), not yet committed a warning (E12). The
 * fixes name the exact output directories (`git add .agents/skills .claude/rules`), never a
 * harness root that holds personal files (M3), and the re-include lines for ignored ones (O2).
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type { CheckProblem, CheckRun } from '../core/types.js';
import { isGitIgnored, isGitTracked, isWithin, toPosix } from '../lib/fs.js';
import { type CheckContext, checkRun, count, found, notApplicable, skipped } from './check-kit.js';

/** git questions asked at once. */
const CONCURRENCY = 8;

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY)
    out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
}

/** Every file palm wrote or merged into, lock form, that exists. */
function writtenFiles(c: CheckContext): string[] {
  const { lock, paths } = c.run.state;
  const files = new Set<string>();
  for (const e of lock.entries) {
    for (const f of e.files) files.add(f);
    for (const m of e.merged ?? []) files.add(m.file);
  }
  return [...files].filter((f) => existsSync(paths.abs(f))).sort();
}

/** The project-relative path git holds for `file` (its real path), or the path itself. */
async function gitPath(c: CheckContext, file: string): Promise<string> {
  const { paths } = c.run.state;
  const real = await realpath(paths.abs(file)).catch(() => undefined);
  const root = await realpath(paths.root).catch(() => paths.root);
  if (!real || !isWithin(real, root)) return file;
  return toPosix(posix.relative(toPosix(root), toPosix(real)));
}

/**
 * The output directory a file is reported under: `.claude/skills/tdd/SKILL.md` →
 * `.claude/skills`; a file two levels deep or less (`.mcp.json`, `.claude/settings.json`) is
 * named itself.
 */
function dirOf(file: string): string {
  const parts = file.split('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : file;
}

function grouped(files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) out.set(dirOf(f), [...(out.get(dirOf(f)) ?? []), f]);
  return out;
}

function listed(files: readonly string[]): string {
  const head = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${head} and ${files.length - 3} more` : head;
}

/** `.mcp.json`, or `12 files under .claude/skills/ (…)`. */
function subject(dir: string, files: string[]): { what: string; one: boolean } {
  const [only] = files;
  if (files.length === 1 && only === dir) return { what: only, one: true };
  return { what: `${count(files.length, 'file')} under ${dir}/ (${listed(files)})`, one: false };
}

/** `!.claude/skills/`, `!.mcp.json`: the line that re-includes one output path. */
function reinclude(dir: string, files: string[]): string {
  return files.length === 1 && files[0] === dir ? `!${dir}` : `!${dir}/`;
}

/**
 * O2: the exact .gitignore lines that bring one output path back. git cannot re-include a path
 * inside an ignored directory, so an ignored `.claude/` becomes `.claude/*` first (its other
 * files, `settings.local.json` among them, stay ignored), then `!.claude/skills/` follows.
 */
function reincludeFix(dir: string, files: string[]): string {
  const line = reinclude(dir, files);
  const top = dir.split('/')[0] ?? dir;
  if (!dir.includes('/')) return `add ${line} to .gitignore`;
  return `in .gitignore, write ${top}/* where it says ${top}/, then add ${line} below it`;
}

function ignoredProblem(dir: string, files: string[]): CheckProblem {
  const s = subject(dir, files);
  const receive = s.one
    ? 'is ignored by git, so teammates will not receive it'
    : 'are ignored by git, so teammates will not receive them';
  return { file: dir, message: `${s.what} ${receive}`, fix: reincludeFix(dir, files) };
}

function untrackedProblem(groups: Map<string, string[]>): CheckProblem {
  const files = [...groups.values()].flat();
  const dirs = [...groups.keys()];
  const [only] = files;
  const what =
    files.length === 1 && only ? only : `${count(files.length, 'file')} (${listed(files)})`;
  return {
    file: dirs[0] ?? '',
    message: `${what} ${files.length === 1 ? 'is' : 'are'} not committed yet (untracked)`,
    fix: `git add ${dirs.join(' ')}`,
  };
}

/** Every file palm wrote or merged into is committed: ignored fails, untracked warns. */
export async function gitIgnored(c: CheckContext): Promise<CheckRun> {
  const what = 'generated files committed';
  if (c.run.state.paths.scope !== 'project')
    return notApplicable('git-ignored', what, 'global scope');
  if (!c.git) return skipped('git-ignored', what);
  const { paths } = c.run.state;
  const files = [...new Set(await mapLimit(writtenFiles(c), (f) => gitPath(c, f)))].sort();
  const states = await mapLimit(files, async (f) => {
    const abs = paths.abs(f);
    if (await isGitIgnored(abs, paths.root)) return 'ignored';
    return (await isGitTracked(abs, paths.root)) === false ? 'untracked' : 'tracked';
  });
  const f = found();
  const ignored = files.filter((_, i) => states[i] === 'ignored');
  const untracked = files.filter((_, i) => states[i] === 'untracked');
  for (const [dir, list] of grouped(ignored)) f.fail.push(ignoredProblem(dir, list));
  if (untracked.length) f.warn.push(untrackedProblem(grouped(untracked)));
  return checkRun(
    'git-ignored',
    {
      ok: 'generated files are committed',
      bad: (n) => `${count(n, 'output path')} ignored by git`,
      warned: () => 'generated files not committed yet',
    },
    f,
  );
}
