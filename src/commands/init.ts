/** `palm init`: choose this project's targets, write them to palm.yaml and ignore .palm/. */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import { type PalmContext, TARGET_IDS, type TargetId } from '../core/types.js';
import { ScopePaths } from '../domain/scope-paths.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { displayPath, type GlobalOptions, makeContext, parseTargetList } from './shared.js';

/** Append `.palm/` to .gitignore text unless an equivalent line is already there. */
export function withPalmIgnored(gitignore: string): string | undefined {
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === '.palm' || l === '.palm/' || l === '/.palm' || l === '/.palm/'))
    return undefined;
  const sep = gitignore === '' || gitignore.endsWith('\n') ? '' : '\n';
  return `${gitignore}${sep}.palm/\n`;
}

async function detectedTargets(ctx: PalmContext): Promise<TargetId[]> {
  const { getTarget } = await import('../targets/index.js');
  const detected: TargetId[] = [];
  for (const id of TARGET_IDS) {
    const t = getTarget(id);
    const hit =
      (await t.detect('project', ctx.paths.projectRoot, ctx.env).catch(() => false)) ||
      (await t.detect('global', ctx.paths.home, ctx.env).catch(() => false));
    if (hit) detected.push(id);
  }
  return detected;
}

async function chooseTargets(ctx: PalmContext, flag: TargetId[] | undefined): Promise<TargetId[]> {
  if (flag) return flag;
  const detected = await detectedTargets(ctx);
  if (ctx.ui.isInteractive && !ctx.flags.yes) {
    const { getTarget } = await import('../targets/index.js');
    const picked = await ctx.ui.pickMany(
      'Which harnesses should this project install into?',
      TARGET_IDS.map((id) => ({
        value: id,
        label: getTarget(id).displayName,
        hint: detected.includes(id) ? 'detected' : undefined,
      })),
      detected,
    );
    if (picked.length === 0) throw usage('pick at least one target', 'palm init --target claude');
    return picked;
  }
  if (detected.length) return detected;
  throw new PalmError(
    'E_NON_INTERACTIVE',
    'no harness detected and no --target given',
    'palm init --target claude,codex',
  );
}

/** True when `dir` or an ancestor holds `.git` (a work tree, or a submodule's `.git` file). */
function insideGitRepo(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * What `palm init` does to `.gitignore`: add `.palm/` (copied hook scripts) to an existing file,
 * or create the file inside a git repository; undefined when there is nothing to do.
 */
async function gitignorePlan(
  root: string,
): Promise<{ file: string; text: string; created: boolean } | undefined> {
  const file = join(root, '.gitignore');
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current === undefined && !insideGitRepo(root)) return undefined;
  const text = withPalmIgnored(current ?? '');
  return text === undefined ? undefined : { file, text, created: current === undefined };
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const g = inv.opts as GlobalOptions;
  if (g.global)
    throw usage(
      '`palm init` sets up a project',
      'for global defaults run: palm config set targets claude,codex',
    );
  const flag = parseTargetList(g.target);
  const ctx = await makeContext(app, g);
  const out = app.out;
  const targets = await chooseTargets(ctx, flag);
  const { Manifest } = await import('../domain/manifest.js');
  const file = ScopePaths.of(ctx, 'project').manifestFile;
  const manifest = await Manifest.load(file);
  const ignore = await gitignorePlan(ctx.paths.projectRoot);
  if (out.jsonMode)
    out.json({ file, targets, gitignore: ignore !== undefined, dryRun: ctx.flags.dryRun });
  if (ctx.flags.dryRun) {
    out.hint(`dry run: would write targets [${targets.join(', ')}] to ${file}`);
    if (ignore)
      out.hint(`dry run: would ${ignore.created ? 'create' : 'add .palm/ to'} ${ignore.file}`);
    return;
  }
  await manifest.setTargets(targets).save(file);
  out.added(`${displayPath(ctx, file)}: targets ${targets.join(', ')}`);
  if (ignore) {
    await writeFile(ignore.file, ignore.text);
    const where = displayPath(ctx, ignore.file);
    out.added(ignore.created ? `${where} (new): .palm/` : `.palm/ in ${where}`);
  }
  out.hint('\nnext: palm search <query>   or   palm install skill <name>@<origin>');
}
