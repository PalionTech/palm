import type { Command } from 'commander';
import pc from 'picocolors';
import { isPalmError } from '../core/errors.js';
import { TARGET_IDS, type TargetId } from '../core/types.js';
import { printTable } from '../ui/output.js';
import { displayPath, makeContext, parseTargetList, printJson, scopeOf, scopeRootOf, type GlobalOptions } from './shared.js';

export function registerTargets(program: Command): void {
  program
    .command('targets')
    .summary('show active and detected targets')
    .description('Show which harnesses palm installs into for this scope, and which ones are detected at each scope.')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const scope = scopeOf(g);
      const flag = parseTargetList(g.target);
      // Never prompt here: this command only reports.
      const ctx = await makeContext(g, { interactive: false });
      const { resolveTargets } = await import('../engine/resolve-targets.js');
      const { getTarget } = await import('../targets/index.js');

      let active: TargetId[] = [];
      let unresolved: string | undefined;
      try {
        active = (await resolveTargets(ctx, { scope, flag, save: false })) as TargetId[];
      } catch (e) {
        if (!isPalmError(e)) throw e;
        unresolved = e.message;
      }

      const rows = await Promise.all(
        TARGET_IDS.map(async (id) => {
          const t = getTarget(id);
          const [project, global] = await Promise.all([
            t.detect('project', ctx.paths.projectRoot, ctx.env).catch(() => false),
            t.detect('global', ctx.paths.home, ctx.env).catch(() => false),
          ]);
          return { id, name: t.displayName, active: active.includes(id), project, global, configDir: t.configDir(scope, scopeRootOf(ctx, scope), ctx.env) };
        }),
      );

      if (g.json) return printJson({ scope, active, unresolved, targets: rows });
      console.log(`${pc.bold(scope)} scope ${pc.dim(scope === 'project' ? ctx.paths.projectRoot : ctx.paths.home)}`);
      printTable(
        rows.map((r) => [r.id, r.name, r.active ? pc.green('✓ active') : '', r.project ? 'yes' : pc.dim('no'), r.global ? 'yes' : pc.dim('no'), displayPath(ctx, r.configDir)]),
        ['target', 'harness', 'status', 'project', 'global', `${scope} config dir`],
      );
      if (unresolved) console.log(pc.yellow(`\n⚠ no targets resolved: ${unresolved}`) + pc.dim('\n  set them with `palm init`, `palm config set targets …` or --target'));
    });
}
