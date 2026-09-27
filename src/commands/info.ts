import type { Command } from 'commander';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import type { Entity, EntityRef, LockEntry, OriginSpec, TargetId } from '../core/types.js';
import { makeContext, printJson, requireKind, scopeOf, shortSha, splitNameOrigin, type GlobalOptions } from './shared.js';

interface InfoOptions extends GlobalOptions {
  origin?: string;
}

/** Best-effort attribution of an installed file to the harness that reads it (paths per DESIGN.md §2). */
export function fileTargetLabel(file: string): TargetId | 'shared .agents' | 'other' {
  const f = file.replace(/\\/g, '/');
  if (/(^|\/)\.agents\/skills\//.test(f)) return 'shared .agents';
  if (/(^|\/)\.claude(\/|\.json$)/.test(f) || /(^|\/)\.mcp\.json$/.test(f)) return 'claude';
  if (/(^|\/)\.codex(\/|$)/.test(f) || /(^|\/)AGENTS\.md$/.test(f)) return 'codex';
  if (/(^|\/)(\.github|\.copilot|\.vscode)\//.test(f)) return 'copilot';
  if (/(^|\/)\.cursor\//.test(f)) return 'cursor';
  return 'other';
}

function groupFiles(files: string[]): Map<string, string[]> {
  const byTarget = new Map<string, string[]>();
  for (const f of files) {
    const label = fileTargetLabel(f);
    byTarget.set(label, [...(byTarget.get(label) ?? []), f]);
  }
  return byTarget;
}

function row(label: string, value: string | undefined): void {
  if (value) console.log(`  ${pc.dim(label.padEnd(12))}${value}`);
}

function kindDetails(e: Entity): Array<[string, string | undefined]> {
  switch (e.def.kind) {
    case 'agent': {
      const a = e.def.agent;
      return [
        ['model', a.model ?? 'inherit'],
        ['tools', a.tools?.length ? a.tools.join(', ') : 'inherit'],
      ];
    }
    case 'mcp': {
      const m = e.def.mcp;
      return [
        ['transport', m.transport],
        ['command', m.command ? [m.command, ...(m.args ?? [])].join(' ') : undefined],
        ['url', m.url],
        ['secrets', m.secrets?.map((s) => s.name).join(', ')],
      ];
    }
    case 'instruction': {
      const i = e.def.instruction;
      return [['applies to', i.globs?.length ? i.globs.join(', ') : i.alwaysApply ? 'always' : 'on request']];
    }
    case 'command':
      return [['arguments', e.def.command.argumentHint]];
    case 'plugin':
      return [['members', e.def.members.map((m) => `${m.kind} ${m.name}`).join(', ')]];
    default:
      return [];
  }
}

export function registerInfo(program: Command): void {
  program
    .command('info')
    .summary('show one entity: origin, version, dependencies, installed files')
    .description('Show an entity: description, origin, version, dependencies and (when installed) the files palm wrote per target.')
    .argument('<kind>', 'entity kind (plurals ok)')
    .argument('<name>', 'name[@origin]')
    .option('-o, --origin <name-or-alias>', 'origin to look in: alias, owner/repo[/root], URL or local path')
    .action(async (kindArg: string, nameArg: string, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<InfoOptions>();
      const kind = requireKind(kindArg);
      const ref = splitNameOrigin(nameArg);
      const scope = scopeOf(o);
      const ctx = await makeContext(o);
      let origin = ref.origin;
      if (o.origin) {
        const { resolveOriginQuery } = await import('../core/config.js');
        try {
          origin = resolveOriginQuery(ctx, o.origin).alias;
        } catch (e) {
          // An origin removed after installing: its lock entries still carry the alias.
          if (!(e instanceof PalmError && e.code === 'E_NOT_FOUND')) throw e;
          origin = o.origin;
        }
      }
      const { getEntityInfo } = await import('../engine/query.js');
      const info: { entity?: Entity; lock?: LockEntry; deps: EntityRef[]; warnings: string[] } = await getEntityInfo(ctx, kind, ref.name, {
        origin,
        scope,
      });
      if (!info.entity && !info.lock) {
        throw new PalmError('E_NOT_FOUND', `no ${kind} named "${ref.name}" in your origins or the ${scope} lockfile`, `try: palm search ${ref.name}`);
      }
      if (o.json) return printJson(info);

      const { entity, lock } = info;
      const originAlias = lock?.origin ?? entity?.origin ?? '';
      let originSpec: OriginSpec | undefined;
      try {
        const { findOrigin } = await import('../core/config.js');
        originSpec = findOrigin(ctx, originAlias);
      } catch {
        originSpec = undefined;
      }

      const status = lock ? pc.green(`installed (${scope})`) : pc.dim('not installed');
      console.log(`${pc.bold(`${kind} ${ref.name}`)}  ${status}`);
      if (entity?.description) console.log(`  ${entity.description}`);
      console.log('');
      row('origin', originAlias);
      row('url', lock?.url ?? originSpec?.url ?? originSpec?.path);
      row('ref', lock?.ref ?? originSpec?.ref);
      row('sha', shortSha(lock?.sha));
      row('path', lock?.path ?? entity?.path);
      row('version', entity?.version);
      row('plugin', entity?.plugin);
      if (entity) for (const [label, value] of kindDetails(entity)) row(label, value);
      row('depends on', info.deps.map((d) => `${d.kind} ${d.name}`).join(', '));
      row('via', lock?.via);
      for (const w of info.warnings) console.log(pc.yellow(`  ⚠ ${w}`));

      if (lock) {
        console.log('');
        console.log(`  ${pc.dim('targets'.padEnd(12))}${lock.targets.join(', ')}`);
        for (const [label, files] of groupFiles(lock.files)) {
          console.log(`  ${pc.bold(label)}`);
          for (const f of files) console.log(`    ${f}`);
        }
        if (lock.merged?.length) {
          console.log(`  ${pc.bold('merged into')}`);
          for (const m of lock.merged) console.log(`    ${m.file} ${pc.dim(m.pointer)}`);
        }
      } else if (entity) {
        console.log(`\n${pc.dim('install with:')} palm install ${kind} ${entity.name}@${entity.origin}`);
      }
    });
}
