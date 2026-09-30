/**
 * `palm get [kind] [names…] [-s source] [--files]` (aliases `list`, `ls`), DESIGN.md §10: what
 * is installed (kind, name, source, ref, sha, targets, file counts, layer), every generated
 * file with `--files`, and `get sources`, `get targets`, `get all`.
 */
import { PalmError } from '../core/errors.js';
import { type Kind, type PalmContext, type Scope, TARGET_IDS } from '../core/types.js';
import type { InstalledRow, ScopeState } from '../create/engine.js';
import { displayLockPath, shortHash } from '../ui/format.js';
import type { App } from './app.js';
import { formatName, type Invocation } from './grammar.js';
import { pluralize } from './ports.js';
import {
  refCell,
  SOURCE_HEADER,
  sourceRows,
  sourceView,
  TARGET_HEADER,
  targetRows,
  targetViews,
} from './scope-view.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface GetFlags extends GlobalOptions {
  source?: string;
  files?: boolean;
}

const INSTALLED_HEADER = ['kind', 'name', 'source', 'ref', 'sha', 'targets', 'files', 'layer'];

function targetsOf(row: InstalledRow): string {
  return TARGET_IDS.filter((t) => row.entry.render[t] !== undefined).join(',');
}

function installedRow(row: InstalledRow): string[] {
  const e = row.entry;
  const merged = e.merged?.length ? ` +${e.merged.length} merged` : '';
  return [
    e.kind,
    e.via ? `${e.name} (${e.via})` : e.name,
    e.source,
    refCell(row.source),
    shortHash(row.source.sha),
    targetsOf(row),
    `${e.files.length}${merged}`,
    row.layer,
  ];
}

function installedJson(row: InstalledRow) {
  const e = row.entry;
  return {
    kind: e.kind,
    name: e.name,
    source: e.source,
    ...(e.via ? { via: e.via } : {}),
    ref: row.source.ref,
    resolved: row.source.resolved,
    sha: row.source.sha,
    tree: row.source.tree,
    targets: targetsOf(row).split(',').filter(Boolean),
    files: e.files,
    merged: (e.merged ?? []).map((m) => m.file),
    layer: row.layer,
  };
}

function fileRows(rows: InstalledRow[]): Array<{ file: string; entry: string; source: string }> {
  return rows.flatMap(({ entry: e }) => [
    ...e.files.map((f) => ({
      file: displayLockPath(f),
      entry: `${e.kind} ${e.name}`,
      source: e.source,
    })),
    ...(e.merged ?? []).map((m) => ({
      file: `${displayLockPath(m.file)} (merged)`,
      entry: `${e.kind} ${e.name}`,
      source: e.source,
    })),
  ]);
}

/** The installed entries, or E_NOT_FOUND when names were given and none of them is installed. */
async function installed(ctx: PalmContext, app: App, inv: Invocation, flags: GetFlags) {
  const kind = inv.resource as Kind | undefined;
  const names = inv.names.map((n) => n.name);
  const q = {
    ...(kind ? { kind } : {}),
    ...(names.length ? { names } : {}),
    ...(flags.source ? { source: flags.source } : {}),
  };
  const rows = await engine(app).listInstalled(ctx, scopeOf(flags), q);
  if (names.length && !rows.length)
    throw new PalmError(
      'E_NOT_FOUND',
      `nothing named ${inv.names.map(formatName).join(', ')} is installed`,
      'palm get',
    );
  return rows;
}

async function printVariables(ctx: PalmContext, app: App, rows: InstalledRow[], scope: Scope) {
  const api = engine(app);
  for (const { entry } of rows.filter((r) => r.entry.kind === 'mcp')) {
    const q = { kind: entry.kind, name: entry.name, source: entry.source };
    const info = await api.describeEntity(ctx, q, { scope }, engineDeps(app));
    const vars = (info.secrets ?? []).map((s) => `${s.name} (${s.set ? 'set' : 'not set'})`);
    if (vars.length) app.out.out(`${entry.name} needs ${vars.join(', ')}`);
  }
}

async function getInstalled(ctx: PalmContext, app: App, inv: Invocation, flags: GetFlags) {
  const rows = await installed(ctx, app, inv, flags);
  const out = app.out;
  if (flags.files) {
    const files = fileRows(rows);
    if (out.jsonMode) return out.json(files);
    return out.table(files.map((f) => [f.file, f.entry, f.source]));
  }
  if (out.jsonMode) return out.json(rows.map(installedJson));
  const kind = inv.resource as Kind | undefined;
  if (!rows.length) {
    out.hint(
      `No ${kind ? pluralize(kind, 2) : 'entities'} installed in the ${scopeOf(flags)} scope.`,
    );
    return out.hint('see what a source offers: palm install <owner/repo>');
  }
  out.table(rows.map(installedRow), INSTALLED_HEADER);
  if (kind === 'mcp') await printVariables(ctx, app, rows, scopeOf(flags));
}

async function getSources(app: App, state: ScopeState): Promise<void> {
  const views = state.sources.all().map((ref) => sourceView(state, ref));
  if (app.out.jsonMode) return app.out.json(views);
  if (!views.length) return app.out.hint('palm.yaml declares no sources yet.');
  app.out.table(sourceRows(views), SOURCE_HEADER);
}

async function getTargets(ctx: PalmContext, app: App, state: ScopeState): Promise<void> {
  const views = await targetViews(app, ctx, state);
  if (app.out.jsonMode) return app.out.json(views);
  app.out.table(targetRows(views), TARGET_HEADER);
}

async function getAll(ctx: PalmContext, app: App, state: ScopeState, flags: GetFlags) {
  const scope = scopeOf(flags);
  const rows = await engine(app).listInstalled(ctx, scope);
  const sources = state.sources.all().map((ref) => sourceView(state, ref));
  const targets = await targetViews(app, ctx, state);
  if (app.out.jsonMode)
    return app.out.json({ installed: rows.map(installedJson), sources, targets });
  const out = app.out;
  out.out(out.colors.bold('Installed'));
  if (rows.length) out.table(rows.map(installedRow), INSTALLED_HEADER);
  else out.hint(`Nothing installed in the ${scope} scope.`);
  out.out(`\n${out.colors.bold('Sources')}`);
  out.table(sourceRows(sources), SOURCE_HEADER);
  out.out(`\n${out.colors.bold('Targets')}`);
  out.table(targetRows(targets), TARGET_HEADER);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as GetFlags;
  const ctx = await makeContext(app, flags);
  const resource = inv.resource;
  if (resource !== 'source' && resource !== 'target' && resource !== 'all')
    return getInstalled(ctx, app, inv, flags);
  const state = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
  if (resource === 'source') return getSources(app, state);
  if (resource === 'target') return getTargets(ctx, app, state);
  return getAll(ctx, app, state, flags);
}
