/**
 * Read-only questions to git about a working tree: is a path ignored, is it tracked, which
 * repository holds a directory. lib knows nothing about how palm runs git, so the runner is
 * injected (`setGitRunner`; src/core/context installs the hardened `runGit`). Without a runner,
 * without git or outside a repository every answer is undefined, and callers skip their check.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Runs `git <args>` in `cwd` and resolves to stdout; rejects on a non-zero exit or when git is missing. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

let runner: GitRunner | undefined;

/** Installs the runner every query goes through (undefined removes it). */
export function setGitRunner(next: GitRunner | undefined): void {
  runner = next;
}

/** stdout of `git <args>` in `cwd`, or undefined when there is no runner or git failed. */
async function run(args: readonly string[], cwd: string): Promise<string | undefined> {
  if (!runner) return undefined;
  try {
    return await runner(args, cwd);
  } catch {
    return undefined;
  }
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** `dir`, or its nearest existing ancestor directory. */
async function existingDir(dir: string): Promise<string> {
  let cur = path.resolve(dir);
  while (!(await isDir(cur))) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/**
 * The working tree root holding `dir` (`git rev-parse --show-toplevel`, run in `dir` or its
 * nearest existing ancestor); undefined outside a repository or without git.
 */
export async function gitToplevel(dir: string): Promise<string | undefined> {
  const out = await run(['rev-parse', '--show-toplevel'], await existingDir(dir));
  return out?.trim() || undefined;
}

/** True when git ignores `abs` (`git check-ignore -q`, run in `cwd`); undefined outside a repository. */
export async function isGitIgnored(abs: string, cwd: string): Promise<boolean | undefined> {
  const dir = await existingDir(cwd);
  if (!(await gitToplevel(dir))) return undefined;
  return (await run(['check-ignore', '-q', '--', abs], dir)) !== undefined;
}

/**
 * `git diff --stat` of the working tree below `dir` (what an update changed, DESIGN §6);
 * undefined outside a repository, without git, or when nothing differs.
 */
export async function gitDiffStat(dir: string): Promise<string | undefined> {
  const cwd = await existingDir(dir);
  if (!(await gitToplevel(cwd))) return undefined;
  const out = await run(['diff', '--stat', '--', '.'], cwd);
  return out?.trimEnd() || undefined;
}

/** True when git tracks `abs` (a file, or any file below a directory); undefined outside a repository. */
export async function isGitTracked(abs: string, cwd: string): Promise<boolean | undefined> {
  const dir = await existingDir(cwd);
  if (!(await gitToplevel(dir))) return undefined;
  const out = await run(['ls-files', '--', abs], dir);
  return out === undefined ? undefined : out.trim() !== '';
}
