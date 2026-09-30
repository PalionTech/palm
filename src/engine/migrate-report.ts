/**
 * What `palm migrate` tells the person after the install (DESIGN §6 "Migrate"): paths as people
 * type them, the failed check as failures, and the files to commit: in a project every path the
 * migration changed or created (untracked output folders 0.1 never committed included); under -g
 * the files it changed inside a git repository, such as a dotfiles checkout reached through links.
 */
import { realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { runGit } from '../core/git-exec.js';
import type { CheckReport, InstallFailure } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { gitToplevel } from '../lib/fs.js';
import type { ScopeState } from './scope.js';

/** `~/…` for a path below the home directory, as people type it. */
export function shown(paths: ScopePaths, abs: string): string {
  const rel = relative(paths.home, abs);
  return rel.startsWith('..') ? abs : `~/${rel}`;
}

/** A path for people: project-relative, or `~/…` under -g (tokens stay in the lock). */
export function display(paths: ScopePaths, abs: string): string {
  return paths.scope === 'global' ? shown(paths, abs) : paths.lockForm(abs);
}

/** One failure per problem of a failed check (code E_CHECK; `MigrateReport.check` holds the check). */
export function checkFailures(report: CheckReport): InstallFailure[] {
  const out: InstallFailure[] = [];
  for (const c of report.checks.filter((r) => r.status === 'fail'))
    for (const p of c.problems) {
      const who = p.entity
        ? { kind: p.entity.kind, name: p.entity.name, source: p.entity.source }
        : { kind: 'source' as const, name: c.id, source: p.file ?? c.label };
      out.push({ ...who, code: 'E_CHECK', message: p.message, ...(p.fix ? { hint: p.fix } : {}) });
    }
  return out;
}

/** `git status --short` in `cwd` for `paths`; undefined outside a repository or without git. */
async function status(cwd: string, paths: string[]): Promise<string[] | undefined> {
  const out = await runGit(['status', '--short', '--untracked-files=all', '--', ...paths], {
    cwd,
  }).catch(() => undefined);
  return out?.split('\n').filter(Boolean);
}

function pathOf(line: string): string {
  return line
    .slice(3)
    .replace(/^.* -> /, '')
    .replace(/^"(.*)"$/, '$1');
}

/** A status line as the path to commit: an untracked file by its top folder; palm's own lock never. */
function commitPath(line: string): string | undefined {
  const path = pathOf(line);
  if (!path || path.startsWith('.palm/lock') || path.startsWith('.palm/local/')) return undefined;
  if (!line.startsWith('??')) return path;
  if (path.startsWith('.palm/assets/')) return '.palm/assets/';
  const slash = path.indexOf('/');
  return slash < 0 ? path : path.slice(0, slash + 1);
}

/** Every lock path of the lock's files and merged files. */
function lockPaths(state: ScopeState): string[] {
  return state.lock.entries.flatMap((e) => [...e.files, ...(e.merged ?? []).map((g) => g.file)]);
}

async function projectCommit(state: ScopeState): Promise<string[] | undefined> {
  const lines = await status(state.paths.root, ['.']);
  if (!lines) return undefined;
  const mine = ['palm.yaml', 'palm.lock.yaml', '.gitignore', '.palm/assets/', ...lockPaths(state)];
  const owned = (p: string) => mine.some((f) => f === p || (p.endsWith('/') && f.startsWith(p)));
  return [...new Set(lines.flatMap((l) => commitPath(l) ?? []).filter(owned))].sort();
}

/** The real files palm wrote under -g, by the git repository holding them. */
async function byRepository(state: ScopeState): Promise<Map<string, string[]>> {
  const { paths } = state;
  const files = [paths.manifestFile, paths.lockFile, ...lockPaths(state).map((p) => paths.abs(p))];
  const reals = await Promise.all(files.map((f) => realpath(f).catch(() => undefined)));
  const tops = new Map<string, string | undefined>();
  const out = new Map<string, string[]>();
  for (const real of new Set(reals.filter((r): r is string => !!r))) {
    const dir = dirname(real);
    if (!tops.has(dir)) tops.set(dir, await gitToplevel(dir));
    const top = tops.get(dir);
    if (top) out.set(top, [...(out.get(top) ?? []), real]);
  }
  return out;
}

async function globalCommit(state: ScopeState): Promise<string[]> {
  const out: string[] = [];
  for (const [top, files] of await byRepository(state)) {
    const lines = await status(top, files);
    for (const l of lines ?? []) out.push(shown(state.paths, join(top, pathOf(l))));
  }
  return out.sort();
}

/** The files to commit after the migration; undefined when the scope is in no repository. */
export async function filesToCommit(state: ScopeState): Promise<string[] | undefined> {
  if (state.paths.scope === 'project') return projectCommit(state);
  const files = await globalCommit(state);
  return files.length ? files : undefined;
}
