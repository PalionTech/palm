/**
 * `palm init [--target ids] [--here]` (DESIGN.md §10): write `targets:` (found here, or the
 * flag) to palm.yaml in this directory and the two ignore lines to .gitignore. Refuses inside a
 * directory with a palm.yaml above it in the same repository unless `--here` (PLAN.md §4.11).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { PalmContext, TargetId } from '../core/types.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import {
  displayPath,
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  parseTargetList,
} from './shared.js';

interface InitFlags extends GlobalOptions {
  target?: string;
  here?: boolean;
}

/** The only palm paths a project ignores (DESIGN.md §2). */
const IGNORE_LINES = ['.palm/local/', 'palm.local.yaml'] as const;

/** `.gitignore` text with the palm lines it lacks appended, and which ones those were. */
export function withIgnoreLines(text: string): { text: string; added: string[] } {
  const have = new Set(
    text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')),
  );
  const added = IGNORE_LINES.filter((l) => !have.has(l.replace(/\/$/, '')));
  if (!added.length) return { text, added };
  const gap = text === '' || text.endsWith('\n') ? '' : '\n';
  return { text: `${text}${gap}${added.join('\n')}\n`, added };
}

/** The nearest directory at or above `dir` that holds `.git`. */
function repoRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

async function refuseNested(ctx: PalmContext, app: App): Promise<void> {
  const cwd = ctx.paths.cwd;
  const enclosing = await engine(app).enclosingProject(cwd, repoRoot(cwd) ?? cwd);
  if (!enclosing || enclosing === cwd) return;
  const rel = relative(enclosing, cwd).split(sep).join('/');
  throw usage(
    `${rel} is inside project ${enclosing} (palm.yaml). Add entries with --at ${rel}, or start a separate project here: palm init --here`,
  );
}

async function gitignore(cwd: string): Promise<{ file: string; text: string; added: string[] }> {
  const file = join(cwd, '.gitignore');
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current === undefined && !repoRoot(cwd)) return { file, text: '', added: [] };
  return { file, ...withIgnoreLines(current ?? '') };
}

async function targetsFor(ctx: PalmContext, app: App, flag: TargetId[] | undefined) {
  if (flag) return flag;
  const api = engine(app);
  const paths = await api.scopePaths('project', ctx.paths.cwd, ctx.paths.palmHome, ctx.env);
  const found = await api.detectTargets(ctx, paths, await api.resolveEngineDeps(engineDeps(app)));
  if (!found.length)
    throw usage(
      'no harness found here (.claude/, .codex/, .github/, .cursor/, .gemini/, .opencode/)',
      'palm init --target claude',
    );
  return found;
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as InitFlags;
  if (flags.global)
    throw usage(
      'palm init sets up a project; -g needs no init',
      'palm install obra/superpowers -g',
    );
  const flag = parseTargetList(flags.target);
  const ctx = await makeContext(app, flags);
  if (!flags.here) await refuseNested(ctx, app);
  const api = engine(app);
  const file = join(ctx.paths.cwd, 'palm.yaml');
  const manifest = await api.loadManifest(file);
  const targets = await targetsFor(ctx, app, flag);
  const ignore = await gitignore(ctx.paths.cwd);
  const out = app.out;
  if (out.jsonMode) out.json({ file, targets, gitignore: ignore.added, dryRun: ctx.flags.dryRun });
  const verb = ctx.flags.dryRun ? 'would write' : 'wrote';
  if (!ctx.flags.dryRun) await manifest.setTargets(targets).save(file);
  if (!ctx.flags.dryRun && ignore.added.length) await writeFile(ignore.file, ignore.text);
  if (out.jsonMode) return;
  out.mark('+', `${verb} ${displayPath(ctx, file)}: targets ${targets.join(', ')}`);
  if (ignore.added.length)
    out.mark('+', `${verb} ${displayPath(ctx, ignore.file)}: ${ignore.added.join(', ')}`);
  out.hint('next: see what a source offers, for example palm install mattpocock/skills');
}
