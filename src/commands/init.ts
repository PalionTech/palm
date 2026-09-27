import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import { TARGET_IDS, type TargetId } from '../core/types.js';
import { displayPath, makeContext, parseTargetList, usage, type GlobalOptions } from './shared.js';

/** Append `.palm/` to .gitignore text unless an equivalent line is already there. */
export function withPalmIgnored(gitignore: string): string | undefined {
  const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === '.palm' || l === '.palm/' || l === '/.palm' || l === '/.palm/')) return undefined;
  const sep = gitignore === '' || gitignore.endsWith('\n') ? '' : '\n';
  return `${gitignore}${sep}.palm/\n`;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .summary('set up palm.yaml for this project')
    .description('Choose the targets for this project and write them to palm.yaml (and ignore .palm/ in .gitignore).')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (g.global) throw usage('`palm init` sets up a project', 'for global defaults use `palm config set targets claude,codex`');
      const flag = parseTargetList(g.target);
      const ctx = await makeContext(g);
      const root = ctx.paths.projectRoot;

      const { getTarget } = await import('../targets/index.js');
      const detected: TargetId[] = [];
      for (const id of TARGET_IDS) {
        const t = getTarget(id);
        const hit = (await t.detect('project', root, ctx.env).catch(() => false)) || (await t.detect('global', ctx.paths.home, ctx.env).catch(() => false));
        if (hit) detected.push(id);
      }

      let targets: TargetId[];
      if (flag) targets = flag;
      else if (ctx.ui.isInteractive && !ctx.flags.yes) {
        targets = await ctx.ui.pickMany(
          'Which harnesses should this project install into?',
          TARGET_IDS.map((id) => ({ value: id, label: getTarget(id).displayName, hint: detected.includes(id) ? 'detected' : undefined })),
          detected,
        );
        if (targets.length === 0) throw usage('pick at least one target');
      } else if (detected.length) targets = detected;
      else throw new PalmError('E_NON_INTERACTIVE', 'no harness detected and no --target given', 'palm init --target claude,codex');

      const { manifestPath } = await import('../core/paths.js');
      const { loadManifest, saveManifest } = await import('../core/manifest.js');
      const file = manifestPath(ctx.paths, 'project');
      const manifest = await loadManifest(file);
      const ignoreFile = join(root, '.gitignore');
      const ignore = await readFile(ignoreFile, 'utf8').catch(() => undefined);
      const nextIgnore = ignore === undefined ? undefined : withPalmIgnored(ignore);

      if (ctx.flags.dryRun) {
        console.log(`would write targets [${targets.join(', ')}] to ${file}`);
        if (nextIgnore !== undefined) console.log(`would add .palm/ to ${ignoreFile}`);
        return;
      }
      await saveManifest(file, { ...manifest, targets });
      ctx.log.success(`${displayPath(ctx, file)}: targets ${targets.join(', ')}`);
      if (nextIgnore !== undefined) {
        await writeFile(ignoreFile, nextIgnore);
        ctx.log.success(`added .palm/ to ${displayPath(ctx, ignoreFile)}`);
      }
      console.log(`\n${pc.dim('next:')} palm search <query>   ${pc.dim('or')}   palm install skill <name>@<origin>`);
    });
}
