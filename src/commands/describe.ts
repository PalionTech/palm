/**
 * `palm describe <kind> <name>` (alias `info`): an entity's origin, version, dependencies and
 * installed files; `describe origin <alias>` and `describe target <id>` show those resources.
 */
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import type {
  Entity,
  EntityRef,
  Kind,
  LockEntry,
  OriginSpec,
  PalmContext,
  Scope,
  TargetId,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { describeOrigin } from './origin-view.js';
import { entityKind, type GlobalOptions, makeContext, scopeOf, shortSha } from './shared.js';
import { describeTarget } from './targets.js';

interface DescribeOptions extends GlobalOptions {
  origin?: string;
}

interface EntityInfo {
  entity?: Entity;
  lock?: LockEntry;
  deps: EntityRef[];
  warnings: string[];
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

function row(out: Output, label: string, value: string | undefined): void {
  if (value) out.out(`  ${pc.dim(label.padEnd(12))}${value}`);
}

function appliesTo(i: { globs?: string[]; alwaysApply: boolean }): string {
  if (i.globs?.length) return i.globs.join(', ');
  return i.alwaysApply ? 'always' : 'on request';
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
    case 'instruction':
      return [['applies to', appliesTo(e.def.instruction)]];
    case 'command':
      return [['arguments', e.def.command.argumentHint]];
    case 'plugin':
      return [['members', e.def.members.map((m) => `${m.kind} ${m.name}`).join(', ')]];
    default:
      return [];
  }
}

/** `-o` names an origin; one removed after installing still matches its lock entries by alias. */
async function originFilter(ctx: PalmContext, query: string | undefined, fallback?: string) {
  if (!query) return fallback;
  const { resolveOriginQuery } = await import('../core/config.js');
  try {
    return resolveOriginQuery(ctx, query).alias;
  } catch (e) {
    if (!(e instanceof PalmError && e.code === 'E_NOT_FOUND')) throw e;
    return query;
  }
}

async function originSpecOf(ctx: PalmContext, alias: string): Promise<OriginSpec | undefined> {
  try {
    const { findOrigin } = await import('../core/config.js');
    return findOrigin(ctx, alias);
  } catch {
    return undefined;
  }
}

function printFiles(out: Output, lock: LockEntry): void {
  out.out();
  out.out(`  ${pc.dim('targets'.padEnd(12))}${lock.targets.join(', ')}`);
  for (const [label, files] of groupFiles(lock.files)) {
    out.out(`  ${pc.bold(label)}`);
    for (const f of files) out.out(`    ${f}`);
  }
  if (!lock.merged?.length) return;
  out.out(`  ${pc.bold('merged into')}`);
  for (const m of lock.merged) out.out(`    ${m.file} ${pc.dim(m.pointer)}`);
}

interface Shown {
  kind: Kind;
  name: string;
  scope: Scope;
  info: EntityInfo;
  spec?: OriginSpec;
}

function printEntity(out: Output, s: Shown): void {
  const { entity, lock } = s.info;
  const status = lock ? pc.green(`installed (${s.scope})`) : pc.dim('not installed');
  out.out(`${pc.bold(`${s.kind} ${s.name}`)}  ${status}`);
  if (entity?.description) out.out(`  ${entity.description}`);
  out.out();
  row(out, 'origin', lock?.origin ?? entity?.origin);
  row(out, 'url', lock?.url ?? s.spec?.url ?? s.spec?.path);
  row(out, 'ref', lock?.ref ?? s.spec?.ref);
  row(out, 'sha', shortSha(lock?.sha));
  row(out, 'path', lock?.path ?? entity?.path);
  row(out, 'version', entity?.version);
  row(out, 'plugin', entity?.plugin);
  if (entity) for (const [label, value] of kindDetails(entity)) row(out, label, value);
  row(out, 'depends on', s.info.deps.map((d) => `${d.kind} ${d.name}`).join(', '));
  row(out, 'via', lock?.via);
  for (const w of s.info.warnings) out.warn(w);
  if (lock) printFiles(out, lock);
  else if (entity)
    out.hint(`\ninstall with: palm install ${s.kind} ${entity.name}@${entity.origin}`);
}

async function describeEntity(ctx: PalmContext, out: Output, kind: Kind, inv: Invocation) {
  const [nameArg, ...extra] = inv.names;
  if (!nameArg || extra.length)
    throw usage(`name one ${kind} to describe`, `palm describe ${kind} <name>[@origin]`);
  const o = inv.opts as DescribeOptions;
  const ref = DepRef.parse(nameArg);
  const scope = scopeOf(o);
  const origin = await originFilter(ctx, o.origin, ref.origin);
  const { getEntityInfo } = await import('../engine/query.js');
  const info: EntityInfo = await getEntityInfo(ctx, kind, ref.name, { origin, scope });
  if (!info.entity && !info.lock)
    throw new PalmError(
      'E_NOT_FOUND',
      `no ${kind} named "${ref.name}" in your origins or the ${scope} lockfile`,
      `search for it: palm search ${kind} ${ref.name}`,
    );
  if (out.jsonMode) return out.json(info);
  const spec = await originSpecOf(ctx, info.lock?.origin ?? info.entity?.origin ?? '');
  printEntity(out, { kind, name: ref.name, scope, info, spec });
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const o = inv.opts as DescribeOptions;
  const scope = scopeOf(o);
  if (inv.resource === 'target') {
    const ctx = await makeContext(app, o, { interactive: false });
    return describeTarget(ctx, app.out, { scope, names: inv.names });
  }
  const ctx = await makeContext(app, o);
  if (inv.resource === 'origin') return describeOrigin(ctx, app.out, inv.names);
  const kind = entityKind(inv.resource, 'describe');
  if (!kind) throw usage('name what to describe', 'palm describe skill <name>');
  return describeEntity(ctx, app.out, kind, inv);
}
