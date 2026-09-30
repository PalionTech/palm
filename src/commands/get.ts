/**
 * `palm get [kind] [names…] [-s source] [--files]` (aliases `list`, `ls`), DESIGN.md §10: what
 * is installed (kind, name, source, ref, sha, targets, file counts, `at:` when set), every
 * generated file with `--files`, and `get sources`, `get targets` (with the scope's root), `get
 * all`. A server declared in palm.yaml shows the source `palm.yaml`; an unknown `--source` is
 * E_NOT_FOUND with the name it nearly is (L14).
 */
import { existsSync } from 'node:fs';
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import { type Kind, type PalmContext, type Scope, TARGET_IDS } from '../core/types.js';
import type { InstalledRow, ScopeState } from '../create/engine.js';
import { displayLockPath, shortHash } from '../ui/format.js';
import type { App } from './app.js';
import { formatName, type Invocation } from './grammar.js';
import { nearest, palmLine } from './hints.js';
import {
  refCell,
  SOURCE_HEADER,
  scopeRoot,
  sourceLabel,
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

/** The `layer` column arrives with palm.local.yaml in 0.3 (D22). */
const INSTALLED_HEADER = ['kind', 'name', 'source', 'ref', 'sha', 'targets', 'files'];

function targetsOf(row: InstalledRow): string {
  return TARGET_IDS.filter((t) => row.entry.render[t] !== undefined).join(',');
}

function installedRow(row: InstalledRow, withAt: boolean): string[] {
  const e = row.entry;
  const merged = e.merged?.length ? ` +${e.merged.length} merged` : '';
  const cells = [
    e.kind,
    e.via ? `${e.name} (${e.via})` : e.name,
    sourceLabel(e.source),
    refCell(row.source),
    shortHash(row.source.sha),
    targetsOf(row),
    `${e.files.length}${merged}`,
  ];
  return withAt ? [...cells, e.at ?? ''] : cells;
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
    ...(e.at ? { at: e.at } : {}),
    layer: row.layer,
  };
}

function fileRows(rows: InstalledRow[]): Array<{ file: string; entry: string; source: string }> {
  return rows.flatMap(({ entry: e }) => [
    ...e.files.map((f) => ({
      file: displayLockPath(f),
      entry: `${e.kind} ${e.name}`,
      source: sourceLabel(e.source),
    })),
    ...(e.merged ?? []).map((m) => ({
      file: `${displayLockPath(m.file)} (merged)`,
      entry: `${e.kind} ${e.name}`,
      source: sourceLabel(e.source),
    })),
  ]);
}

/** L14: the `--source` filter as the lock names it; an unknown one is E_NOT_FOUND. */
async function sourceFilter(ctx: PalmContext, app: App, flags: GetFlags) {
  const query = flags.source;
  if (query === undefined) return undefined;
  if (query === 'palm.yaml') return 'manifest';
  const scope = scopeOf(flags);
  const state = await engine(app).openScope(ctx, scope, { readOnly: true });
  const declared = state.sources.byName(query)?.name;
  if (declared || state.lock.source(query)) return declared ?? query;
  const names = state.sources.all().flatMap((s) => [s.name, ...(s.alias ? [s.alias] : [])]);
  const near = nearest(query, names);
  throw new PalmError(
    'E_NOT_FOUND',
    `no source "${query}" in ${scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml'}${near ? `; did you mean ${near}?` : ''}`,
    near ? palmLine('get', ['--source', near], scope) : palmLine('get', ['sources'], scope),
  );
}

/** The installed entries, or E_NOT_FOUND when names were given and none of them is installed. */
async function installed(ctx: PalmContext, app: App, inv: Invocation, flags: GetFlags) {
  const kind = inv.resource as Kind | undefined;
  const names = inv.names.map((n) => n.name);
  const source = await sourceFilter(ctx, app, flags);
  const q = {
    ...(kind ? { kind } : {}),
    ...(names.length ? { names } : {}),
    ...(source ? { source } : {}),
  };
  const rows = await engine(app).listInstalled(ctx, scopeOf(flags), q);
  if (names.length && !rows.length)
    throw new PalmError(
      'E_NOT_FOUND',
      `nothing named ${inv.names.map(formatName).join(', ')} is installed`,
      palmLine('get', [], scopeOf(flags)),
    );
  return rows;
}

/** An MCP server's variables and whether each is set (describe computes them). */
async function variablesOf(ctx: PalmContext, app: App, row: InstalledRow, scope: Scope) {
  const { entry } = row;
  const q = { kind: entry.kind, name: entry.name, source: entry.source };
  const info = await engine(app).describeEntity(ctx, q, { scope }, engineDeps(app));
  return info.secrets ?? [];
}

async function printVariables(ctx: PalmContext, app: App, rows: InstalledRow[], scope: Scope) {
  for (const row of rows.filter((r) => r.entry.kind === 'mcp')) {
    const vars = (await variablesOf(ctx, app, row, scope)).map(
      (s) => `${s.name} (${s.set ? 'set' : 'not set'})`,
    );
    if (vars.length) app.out.out(`${row.entry.name} needs ${vars.join(', ')}`);
  }
}

/** Y26: `get mcp --json` carries each server's variables. */
async function installedDocs(ctx: PalmContext, app: App, rows: InstalledRow[], scope: Scope) {
  const docs = [];
  for (const row of rows) {
    const doc = installedJson(row);
    if (row.entry.kind !== 'mcp') docs.push(doc);
    else docs.push({ ...doc, variables: await variablesOf(ctx, app, row, scope) });
  }
  return docs;
}

function printInstalled(app: App, rows: InstalledRow[]): void {
  const withAt = rows.some((r) => r.entry.at);
  const header = withAt ? [...INSTALLED_HEADER, 'at'] : INSTALLED_HEADER;
  app.out.table(
    rows.map((r) => installedRow(r, withAt)),
    header,
  );
}

async function getInstalled(ctx: PalmContext, app: App, inv: Invocation, flags: GetFlags) {
  const rows = await installed(ctx, app, inv, flags);
  const out = app.out;
  const scope = scopeOf(flags);
  if (flags.files) {
    const files = fileRows(rows);
    if (out.jsonMode) return out.json(files);
    return out.table(files.map((f) => [f.file, f.entry, f.source]));
  }
  if (out.jsonMode) return out.json(await installedDocs(ctx, app, rows, scope));
  const kind = inv.resource as Kind | undefined;
  if (!rows.length) {
    out.hint(`No ${kind ? pluralize(kind, 2) : 'entities'} installed in the ${scope} scope.`);
    const line = palmLine('install', ['mattpocock/skills'], scope);
    return out.hint(`see what a source offers, for example: ${line}`);
  }
  printInstalled(app, rows);
  if (kind === 'mcp') await printVariables(ctx, app, rows, scope);
}

async function getSources(app: App, state: ScopeState): Promise<void> {
  const views = state.sources.all().map((ref) => sourceView(state, ref));
  if (app.out.jsonMode) return app.out.json(views);
  if (views.length) return app.out.table(sourceRows(views), SOURCE_HEADER);
  const scope = state.paths.scope;
  const line = palmLine('install', ['mattpocock/skills'], scope);
  if (!existsSync(state.paths.manifestFile))
    return app.out.hint(`No palm.yaml here yet; see what a source offers: ${line}`);
  app.out.hint(`palm.yaml declares no sources yet; see what a source offers: ${line}`);
}

/** B16: the targets with the root they resolve against. */
async function getTargets(ctx: PalmContext, app: App, state: ScopeState): Promise<void> {
  const views = await targetViews(app, ctx, state);
  const root = scopeRoot(ctx, state);
  if (app.out.jsonMode) return app.out.json({ root: state.paths.root, items: views });
  app.out.out(`root: ${root}`);
  app.out.table(targetRows(views), TARGET_HEADER);
}

async function getAll(ctx: PalmContext, app: App, state: ScopeState, flags: GetFlags) {
  const scope = scopeOf(flags);
  const rows = await engine(app).listInstalled(ctx, scope);
  const sources = state.sources.all().map((ref) => sourceView(state, ref));
  const targets = await targetViews(app, ctx, state);
  if (app.out.jsonMode) {
    const installedList = await installedDocs(ctx, app, rows, scope);
    return app.out.json({ installed: installedList, sources, targets, root: state.paths.root });
  }
  const out = app.out;
  out.out(out.colors.bold('Installed'));
  if (rows.length) printInstalled(app, rows);
  else out.hint(`Nothing installed in the ${scope} scope.`);
  out.out(`\n${out.colors.bold('Sources')}`);
  out.table(sourceRows(sources), SOURCE_HEADER);
  out.out(`\n${out.colors.bold('Targets')}  (root: ${scopeRoot(ctx, state)})`);
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
