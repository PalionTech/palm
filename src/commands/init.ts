/**
 * `palm init [--target ids] [--here] [-g]` (DESIGN.md §10): write `targets:` (found here, or the
 * flag) to palm.yaml in this directory and the two ignore lines to .gitignore; with -g, to
 * ~/.palm/palm.yaml (J12, D5, R9). What was found is printed with its evidence (`codex
 * (AGENTS.md)`), and on a terminal the person may change the set before it is written (C25).
 * Refuses inside a directory with a palm.yaml above it in the same repository unless `--here`
 * (PLAN.md §4.11), and where a project cannot be (the scope guards of openScope).
 */
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { PalmError } from '../core/errors.js';
import { initRefusal } from '../core/paths.js';
import { type PalmContext, type Scope, TARGET_IDS, type TargetId } from '../core/types.js';
import { targetOf } from '../create/engine.js';
import type { Manifest } from '../domain/manifest.js';
import type { App } from './app.js';
import { importHint } from './foreign-lists.js';
import { type Invocation, usage } from './grammar.js';
import { palmLine } from './hints.js';
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
  /** The second spelling of --target. */
  targets?: string;
  here?: boolean;
}

/** The only palm paths a project ignores (DESIGN.md §2). */
const IGNORE_LINES = ['.palm/local/', 'palm.local.yaml'] as const;

/** `.gitignore` text with the palm lines it lacks appended, and which ones those were. */
function withIgnoreLines(text: string): { text: string; added: string[] } {
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
    `${rel} is inside project ${enclosing} (palm.yaml). Add entries with --at ${rel} (placed at the root until 0.3), or start a separate project here: palm init --here`,
  );
}

async function gitignore(cwd: string): Promise<{ file: string; text: string; added: string[] }> {
  const file = join(cwd, '.gitignore');
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current === undefined && !repoRoot(cwd)) return { file, text: '', added: [] };
  return { file, ...withIgnoreLines(current ?? '') };
}

/** The directory init writes palm.yaml into, and its root for detection. */
function placeOf(ctx: PalmContext, scope: Scope): { dir: string; root: string } {
  if (scope === 'global') return { dir: ctx.paths.palmHome, root: ctx.paths.home };
  return { dir: ctx.paths.cwd, root: ctx.paths.cwd };
}

async function detect(ctx: PalmContext, app: App, scope: Scope): Promise<TargetId[]> {
  const api = engine(app);
  const { root } = placeOf(ctx, scope);
  const paths = await api.scopePaths(scope, root, ctx.paths.palmHome, ctx.env);
  return api.detectTargets(ctx, paths, await api.resolveEngineDeps(engineDeps(app)));
}

/**
 * C25 Y15: `codex (.codex/)`: the file or directory that marked the harness as used here
 * (`Target.evidence`), as the person types it.
 */
async function evidenceOf(ctx: PalmContext, app: App, id: TargetId, scope: Scope) {
  const target = await targetOf(app.deps ?? {}, id);
  const root = scope === 'global' ? ctx.paths.home : ctx.paths.cwd;
  const found = await target.evidence?.(scope, root, ctx.env);
  if (!found) return undefined;
  const shown =
    scope === 'global'
      ? displayPath(ctx, found, 'global')
      : relative(ctx.paths.cwd, found).split(sep).join('/');
  return existsSync(found) && statSync(found).isDirectory() ? `${shown}/` : shown;
}

/** L13: with nothing found here, the harnesses found in the home directory make the example. */
async function noHarness(ctx: PalmContext, app: App, scope: Scope): Promise<PalmError> {
  const home = scope === 'project' ? await detect(ctx, app, 'global').catch(() => []) : [];
  const ids = home.length ? home.join(',') : 'claude';
  const where =
    scope === 'global'
      ? 'no harness found in your home directory (~/.claude, ~/.codex, ~/.cursor, ...)'
      : 'no harness found here (.claude/, .codex/, .github/, .cursor/, .gemini/, .opencode/)';
  return usage(where, palmLine('init', ['--target', ids], scope));
}

/** L13, C25: the targets found (with evidence), which a person on a terminal may change. */
async function detected(ctx: PalmContext, app: App, scope: Scope): Promise<TargetId[]> {
  const found = await detect(ctx, app, scope);
  if (!found.length) throw await noHarness(ctx, app, scope);
  const shown: string[] = [];
  for (const id of found) {
    const why = await evidenceOf(ctx, app, id, scope);
    shown.push(why ? `${id} (${why})` : id);
  }
  if (!app.out.jsonMode) app.out.info(`found ${shown.join(', ')}`);
  if (!ctx.ui.isInteractive || ctx.flags.yes || ctx.flags.dryRun) return found;
  const options = TARGET_IDS.map((id) => ({ value: id, label: id }));
  const chosen = await ctx.ui.pickMany('Targets for palm.yaml', options, found);
  if (!chosen.length) throw new PalmError('E_CANCELLED', 'no target chosen');
  return TARGET_IDS.filter((id) => chosen.includes(id));
}

/**
 * K14 B8 C10 J4 J5: the home directory and the global directories are never a project. J6': the
 * hint keeps the typed `--target`, else names the harness whose directory this is.
 */
function refuseGlobalDir(ctx: PalmContext, typed: TargetId[] | undefined): void {
  const why = initRefusal(ctx.paths.cwd, ctx.paths, ctx.env);
  if (!why) return;
  const inside = /global (\w+) directory/.exec(why)?.[1] ?? '';
  const harness = (TARGET_IDS as readonly string[]).includes(inside) ? inside : 'claude';
  const targets = typed?.join(',') ?? harness;
  throw usage(
    `${why}; your own setup is the global scope`,
    palmLine('init', ['--target', targets], 'global'),
  );
}

/** C11: `skills-lock.json` or `apm.yml` in a project whose palm.yaml lists nothing yet. */
async function noteForeignLists(ctx: PalmContext, app: App, manifest: Manifest): Promise<void> {
  const listed = async () => manifest.allEntries().length + Object.keys(manifest.mcp).length > 0;
  const lines = await importHint(ctx.paths.cwd, 'project', listed);
  const [first, ...rest] = lines ?? [];
  if (!first || app.out.jsonMode) return;
  app.out.info(first);
  for (const l of rest) app.out.hint(l);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as InitFlags;
  const scope: Scope = flags.global ? 'global' : 'project';
  const flag = parseTargetList(flags.target ?? flags.targets);
  const ctx = await makeContext(app, flags);
  if (scope === 'project') {
    refuseGlobalDir(ctx, flag);
    await engine(app).openScope(ctx, 'project', { readOnly: true });
    if (!flags.here) await refuseNested(ctx, app);
  }
  const file = join(placeOf(ctx, scope).dir, 'palm.yaml');
  const manifest = await engine(app).loadManifest(file);
  if (scope === 'project') await noteForeignLists(ctx, app, manifest);
  const current = manifest.targets;
  if (current && !flag) {
    if (app.out.jsonMode) return app.out.json({ file, targets: current, changed: false });
    app.out.info(`${displayPath(ctx, file, scope)} already lists targets: ${current.join(', ')}`);
    return app.out.hint(`change them: ${palmLine('init', ['--target', current.join(',')], scope)}`);
  }
  const targets = flag ?? (await detected(ctx, app, scope));
  await writeInit(ctx, app, { file, manifest, targets, scope });
}

async function writeInit(
  ctx: PalmContext,
  app: App,
  job: { file: string; manifest: Manifest; targets: TargetId[]; scope: Scope },
): Promise<void> {
  const { file, targets, scope } = job;
  const ignore = scope === 'project' ? await gitignore(ctx.paths.cwd) : undefined;
  const added = ignore?.added ?? [];
  const out = app.out;
  const dry = ctx.flags.dryRun;
  if (!dry) await job.manifest.setTargets(targets).save(file);
  if (!dry && ignore && added.length) await writeFile(ignore.file, ignore.text);
  if (out.jsonMode) return out.json({ file, targets, gitignore: added, dryRun: dry });
  const verb = dry ? 'would write' : 'wrote';
  out.mark('+', `${verb} ${displayPath(ctx, file, scope)}: targets ${targets.join(', ')}`);
  if (ignore && added.length)
    out.mark('+', `${verb} ${displayPath(ctx, ignore.file)}: ${added.join(', ')}`);
  const next = palmLine('install', ['mattpocock/skills'], scope);
  out.hint(`next: see what a source offers, for example: ${next}`);
}
