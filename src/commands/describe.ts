/**
 * `palm describe <[kind:]name or path>` (alias `info`), DESIGN.md §10: one entity (source,
 * version, files per harness, notes, `at:`, what selected it, its programs and their trust, the
 * variables a server needs); `describe <source> <name>` for an entity a source offers, installed
 * or not (J21); for a path or a bare file name, the entity that wrote it (V12); `describe source
 * <s>` and `describe target <t>`. A name two entries answer to is E_AMBIGUOUS whose hints name
 * the source (K18, J15).
 */
import { PalmError } from '../core/errors.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { EntityRefSpec, Kind, PalmContext, Scope } from '../core/types.js';
import type { InstalledRow } from '../create/engine.js';
import { displayLockPath } from '../ui/format.js';
import type { App } from './app.js';
import { describeAvailable, printEntity } from './describe-entity.js';
import { describeSource, describeTarget } from './describe-scope.js';
import { formatName, type Invocation, usage } from './grammar.js';
import { palmLine } from './hints.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface DescribeFlags extends GlobalOptions {
  source?: string;
}

function isPath(name: string): boolean {
  return /[/\\]/.test(name) || name.startsWith('.') || name.startsWith('~');
}

/** K18, J15: the one installed entry `ref` names; several is E_AMBIGUOUS naming each source. */
async function pickInstalled(ctx: PalmContext, app: App, ref: EntityRefSpec, flags: DescribeFlags) {
  const scope = scopeOf(flags);
  const q = {
    ...(ref.kind ? { kind: ref.kind } : {}),
    names: [ref.name],
    ...(flags.source ? { source: flags.source } : {}),
  };
  const rows = await engine(app).listInstalled(ctx, scope, q);
  if (rows.length < 2) return rows[0];
  const forms = rows.map((r) => `${r.entry.kind}:${r.entry.name} from ${r.entry.source}`);
  const lines = rows.map((r) => `  ${describeLine(r, scope)}`);
  throw new PalmError(
    'E_AMBIGUOUS',
    `"${ref.name}" names ${rows.length} installed entries: ${forms.join(', ')}`,
    lines.join('\n'),
  );
}

function describeLine(r: InstalledRow, scope: Scope): string {
  return palmLine('describe', [r.entry.source, `${r.entry.kind}:${r.entry.name}`], scope);
}

/** V12: a bare file name (`setup.sh`) as the one installed path that ends with it. */
async function pathOfFileName(ctx: PalmContext, app: App, name: string, scope: Scope) {
  const rows = await engine(app).listInstalled(ctx, scope);
  const paths = rows.flatMap(({ entry: e }) => [
    ...e.files,
    ...(e.merged ?? []).map((m) => m.file),
  ]);
  const hits = [...new Set(paths.filter((p) => p === name || p.endsWith(`/${name}`)))];
  if (hits.length < 2) return hits[0];
  throw new PalmError(
    'E_AMBIGUOUS',
    `${hits.length} installed files are named ${name}: ${hits.map(displayLockPath).join(', ')}`,
    hits.map((h) => `  ${palmLine('describe', [displayLockPath(h)], scope)}`).join('\n'),
  );
}

/** Not installed: where to look (J21: `describe <source> <name>` reads a source's index). */
async function notInstalled(ctx: PalmContext, app: App, ref: EntityRefSpec, scope: Scope) {
  const state = await engine(app).openScope(ctx, scope, { readOnly: true });
  const names = state.sources.names();
  const where = scope === 'global' ? 'globally' : 'in this project';
  const hint =
    names.length === 1
      ? `describe it from its source: ${palmLine('describe', [names[0] as string, formatName(ref)], scope)}`
      : `list what is installed: ${palmLine('get', [], scope)}`;
  return new PalmError('E_NOT_FOUND', `${formatName(ref)} is not installed ${where}`, hint);
}

async function describeName(ctx: PalmContext, app: App, ref: EntityRefSpec, flags: DescribeFlags) {
  const scope = scopeOf(flags);
  const row = await pickInstalled(ctx, app, ref, flags);
  if (!row) {
    const path = ref.kind ? undefined : await pathOfFileName(ctx, app, ref.name, scope);
    if (path) return describePath(ctx, app, path, flags);
    throw await notInstalled(ctx, app, ref, scope);
  }
  const e = row.entry;
  const q = { kind: e.kind, name: e.name, source: e.source };
  const info = await engine(app).describeEntity(ctx, q, { scope }, engineDeps(app));
  if (app.out.jsonMode) return app.out.json(info);
  printEntity(app.out, info, scope);
}

async function describePath(ctx: PalmContext, app: App, path: string, flags: DescribeFlags) {
  const scope = scopeOf(flags);
  const owners = await engine(app).ownerOfPath(ctx, path, { scope });
  if (!owners.length) {
    const state = await engine(app)
      .openScope(ctx, scope, { readOnly: true })
      .catch(() => undefined);
    const source = state?.sources.byName(path)?.name;
    const hint = source
      ? palmLine('describe', ['source', source], scope)
      : palmLine('get', ['--files'], scope);
    throw new PalmError('E_NOT_FOUND', `no installed entity wrote ${path}`, hint);
  }
  if (app.out.jsonMode) return app.out.json(owners);
  for (const { entry: e, match, file } of owners)
    app.out.out(`${displayLockPath(file)}  ${match} of ${e.kind} ${e.name} from ${e.source}`);
}

/** `describe <source> <name>` (J21): two words, the first a source palm.yaml declares or an input form. */
async function sourceAndName(ctx: PalmContext, app: App, inv: Invocation, flags: DescribeFlags) {
  const [first, second] = inv.names;
  if (!first || !second || first.kind || inv.resource) return false;
  const state = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
  const declared = state.sources.byName(first.name);
  if (!declared && !looksLikeSourceInput(first.name)) return false;
  const source = declared?.name ?? first.name;
  const installed = await pickInstalled(ctx, app, second, { ...flags, source });
  if (installed) await describeName(ctx, app, second, { ...flags, source });
  else await describeAvailable(ctx, app, { source, ref: second, state });
  return true;
}

function oneName(inv: Invocation): EntityRefSpec {
  const [first, ...rest] = inv.names;
  if (!first) throw usage('name what to describe', 'palm get');
  if (rest.length)
    throw usage('describe shows one thing at a time', `palm describe ${formatName(first)}`);
  return first;
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as DescribeFlags;
  const ctx = await makeContext(app, flags);
  if (inv.resource === 'source' || inv.resource === 'target') {
    const first = oneName(inv);
    const state = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
    if (inv.resource === 'source') return describeSource(ctx, app, state, first.name);
    return describeTarget(ctx, app, state, first.name);
  }
  if (await sourceAndName(ctx, app, inv, flags)) return;
  const first = oneName(inv);
  if (!inv.resource && !first.kind && isPath(first.name))
    return describePath(ctx, app, first.name, flags);
  const kind = (inv.resource as Kind | undefined) ?? first.kind;
  return describeName(ctx, app, kind ? { kind, name: first.name } : { name: first.name }, flags);
}
