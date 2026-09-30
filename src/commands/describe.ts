/**
 * `palm describe <[kind:]name or path>` (alias `info`), DESIGN.md §10: one entity (source,
 * version, files per harness, notes, what selected it, its programs and their trust, the
 * variables a server needs); for a path, the entity that wrote it; `describe source <s>` and
 * `describe target <t>`.
 */
import { PalmError } from '../core/errors.js';
import {
  type EntityRefSpec,
  KINDS,
  type Kind,
  type PalmContext,
  TARGET_IDS,
} from '../core/types.js';
import {
  type EntityInfo,
  type ScopeState,
  type SourceListing,
  targetOf,
} from '../create/engine.js';
import { displayLockPath, shortHash } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { formatName, type Invocation, usage } from './grammar.js';
import { looksLikeSourceInput, pluralize } from './ports.js';
import { refCell, sourceView, targetViews } from './scope-view.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface DescribeFlags extends GlobalOptions {
  source?: string;
}

function field(out: Output, label: string, value: string | undefined): void {
  if (value) out.out(`  ${out.colors.dim(label.padEnd(12))}${value}`);
}

function isPath(name: string): boolean {
  return /[/\\]/.test(name) || name.startsWith('.') || name.startsWith('~');
}

const setWord = (s: { name: string; set: boolean }) => `${s.name} (${s.set ? 'set' : 'not set'})`;

function printFiles(out: Output, info: EntityInfo): void {
  for (const t of TARGET_IDS) {
    const files = info.files[t];
    if (files?.length) field(out, t, files.map(displayLockPath).join(', '));
  }
  for (const m of info.entry.merged ?? [])
    field(out, 'merged', `${displayLockPath(m.file)} ${m.at}`);
}

function printExec(out: Output, info: EntityInfo): void {
  if (!info.exec) return;
  for (const c of info.exec.commands) field(out, 'runs', `${c.id}  ${c.command}`);
  const hash = `sha256:${shortHash(info.exec.hash, 8)}`;
  const e = info.entry;
  const allow = `palm install --allow-exec ${e.kind}:${e.name}@${e.source}=${hash}`;
  field(out, 'trust', info.exec.trusted ? `trusted (${hash})` : `not trusted; allow it: ${allow}`);
}

function printEntity(out: Output, info: EntityInfo, scope: string): void {
  const e = info.entry;
  out.out(`${out.colors.bold(`${e.kind} ${e.name}`)}  (installed, ${scope} scope)`);
  if (info.entity?.description) out.out(`  ${info.entity.description}`);
  field(out, 'source', [e.source, info.source.url ?? info.source.path].filter(Boolean).join('  '));
  field(out, 'ref', [refCell(info.source), shortHash(info.source.sha)].filter(Boolean).join('  '));
  field(out, 'path', e.path);
  field(out, 'version', info.entity?.version);
  field(out, 'selected by', info.selectedBy === 'manifest' ? 'palm.yaml' : info.selectedBy);
  field(out, 'members', e.deps?.map((d) => `${d.kind} ${d.name}`).join(', '));
  printFiles(out, info);
  for (const note of info.notes) field(out, 'note', note);
  printExec(out, info);
  field(out, 'variables', info.secrets?.map(setWord).join(', '));
}

async function describeName(ctx: PalmContext, app: App, ref: EntityRefSpec, flags: DescribeFlags) {
  const q = flags.source ? { ...ref, source: flags.source } : ref;
  const scope = scopeOf(flags);
  const info = await engine(app).describeEntity(ctx, q, { scope }, engineDeps(app));
  if (app.out.jsonMode) return app.out.json(info);
  printEntity(app.out, info, scope);
}

async function describePath(ctx: PalmContext, app: App, path: string, flags: DescribeFlags) {
  const owners = await engine(app).ownerOfPath(ctx, path, { scope: scopeOf(flags) });
  if (!owners.length) {
    const hint = looksLikeSourceInput(path) ? `palm describe source ${path}` : 'palm get --files';
    throw new PalmError('E_NOT_FOUND', `no installed entity wrote ${path}`, hint);
  }
  if (app.out.jsonMode) return app.out.json(owners);
  for (const { entry: e, match, file } of owners)
    app.out.out(`${displayLockPath(file)}  ${match} of ${e.kind} ${e.name} from ${e.source}`);
}

function offers(listed: SourceListing | undefined): string {
  if (!listed) return 'unknown (palm could not fetch it)';
  const counts = KINDS.map(
    (k) => [k, listed.index.entities.filter((e) => e.kind === k).length] as const,
  );
  const shown = counts.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${pluralize(k, n)}`);
  return shown.join(', ') || 'nothing palm can install';
}

async function describeSource(ctx: PalmContext, app: App, state: ScopeState, name: string) {
  const ref = state.sources.byName(name);
  if (!ref)
    throw new PalmError(
      'E_NOT_FOUND',
      `palm.yaml declares no source "${name}"`,
      'palm get sources',
    );
  const view = sourceView(state, ref);
  const api = engine(app);
  const scope = state.paths.scope;
  const listed = await api
    .listSource(ctx, ref.name, { scope }, engineDeps(app))
    .catch(() => undefined);
  for (const w of listed?.index.warnings ?? []) app.out.warn(`${ref.name}: ${w}`);
  const { root, layout } = ref.source;
  const detected = listed?.index.detected ?? state.lock.source(ref.name)?.descriptor;
  if (app.out.jsonMode)
    return app.out.json({ ...view, root, layout, detected, offers: offers(listed) });
  const out = app.out;
  out.out(out.colors.bold(`source ${ref.name}`));
  field(out, ref.isLocal ? 'path' : 'url', view.location);
  field(out, 'alias', view.alias);
  field(out, 'ref', view.ref);
  field(out, ref.isLocal ? 'tree' : 'sha', shortHash(view.sha ?? view.tree));
  field(out, 'root', root);
  field(out, 'layout', layout ? JSON.stringify(layout) : undefined);
  field(out, 'detected', detected);
  field(out, 'installed', String(view.entries));
  field(out, 'offers', offers(listed));
}

async function describeTarget(ctx: PalmContext, app: App, state: ScopeState, id: string) {
  const view = (await targetViews(app, ctx, state)).find((t) => t.id === id.toLowerCase());
  if (!view)
    throw usage(
      `"${id}" is not a target (${TARGET_IDS.join(', ')})`,
      'palm describe target claude',
    );
  const target = await targetOf(app.deps ?? {}, view.id);
  const dirs = target.outputDirs(state.paths.scope, state.paths.root, ctx.env);
  if (app.out.jsonMode) return app.out.json({ ...view, outputDirs: dirs });
  const out = app.out;
  out.out(`${out.colors.bold(`target ${view.id}`)}  (${view.name})`);
  field(out, 'active', view.active ? 'yes' : 'no (add it to targets: in palm.yaml)');
  field(out, 'config dir', view.configDir);
  field(out, 'writes to', dirs.map(displayLockPath).join(', '));
}

function oneName(inv: Invocation): EntityRefSpec {
  const [first, ...rest] = inv.names;
  if (!first) throw usage('name what to describe', 'palm get');
  if (rest.length)
    throw usage('palm describe shows one thing at a time', `palm describe ${formatName(first)}`);
  return first;
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as DescribeFlags;
  const first = oneName(inv);
  const ctx = await makeContext(app, flags);
  if (inv.resource === 'source' || inv.resource === 'target') {
    const state = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
    if (inv.resource === 'source') return describeSource(ctx, app, state, first.name);
    return describeTarget(ctx, app, state, first.name);
  }
  if (!inv.resource && !first.kind && isPath(first.name))
    return describePath(ctx, app, first.name, flags);
  const kind = (inv.resource as Kind | undefined) ?? first.kind;
  return describeName(ctx, app, kind ? { kind, name: first.name } : { name: first.name }, flags);
}
