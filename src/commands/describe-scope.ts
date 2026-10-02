/**
 * `palm describe source <s>` and `palm describe target <t>`: one declared source (location, ref,
 * one hash, the layout as YAML, what it offers) and one target (active or not, where each kind
 * goes, the root it resolves against, `~/…` under -g).
 */
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import { looksLikeSourceInput } from '../core/source-input.js';
import {
  KINDS,
  type LayoutDescriptor,
  type PalmContext,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { type ScopeState, type SourceListing, targetOf } from '../create/engine.js';
import { displayLockPath, shortHash } from '../ui/format.js';
import type { App } from './app.js';
import { field } from './describe-entity.js';
import { usage } from './grammar.js';
import { manifestFile, nearest, palmLine } from './hints.js';
import { activeTargets, scopeRoot, sourceView, targetViews } from './scope-view.js';
import { displayPath, engine, engineDeps } from './shared.js';

type TokenName = Parameters<ScopeState['paths']['token']>[0];
const TOKEN_NAMES: ReadonlySet<string> = new Set([
  'home',
  'palm',
  'agents',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'opencode',
]);

function offers(listed: SourceListing | undefined): string {
  if (!listed) return 'unknown (palm could not fetch it)';
  const counts = KINDS.map(
    (k) => [k, listed.index.entities.filter((e) => e.kind === k).length] as const,
  );
  const shown = counts.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${pluralize(k, n)}`);
  return shown.join(', ') || 'nothing palm can install';
}

/** K22: the layout as YAML lines (`skills: [packages/*]`), one per kind. */
function layoutLines(layout: LayoutDescriptor | undefined): string[] {
  return Object.entries(layout ?? {}).map(([k, v]) => `${k}: [${[v].flat().join(', ')}]`);
}

function unknownSource(state: ScopeState, name: string, near: string | undefined): PalmError {
  const scope = state.paths.scope;
  return new PalmError(
    'E_NOT_FOUND',
    `${manifestFile(scope)} declares no source "${name}"${near ? `; did you mean ${near}?` : ''}`,
    near ? palmLine('describe', ['source', near], scope) : palmLine('get', ['sources'], scope),
  );
}

/**
 * Q18: a source palm.yaml does not declare, described from its listing (what it offers and the
 * notes from indexing it): the one place the listing's note line points to.
 */
async function describeUndeclared(ctx: PalmContext, app: App, state: ScopeState, input: string) {
  const scope = state.paths.scope;
  const listed = await engine(app).listSource(ctx, input, { scope }, engineDeps(app));
  const { checkout, index } = listed;
  for (const w of index.warnings) app.out.warn(`${input}: ${w}`);
  const detected = index.detected;
  if (app.out.jsonMode)
    return app.out.json({
      name: input,
      declared: false,
      ...checkout,
      detected,
      offers: offers(listed),
    });
  const out = app.out;
  out.out(out.colors.bold(`source ${input}`));
  field(out, 'declared', `no; an install from it declares it in ${manifestFile(scope)}`);
  field(out, 'ref', checkout.ref);
  field(out, checkout.sha ? 'sha' : 'tree', shortHash(checkout.sha ?? checkout.tree));
  field(out, 'detected', detected);
  field(out, 'offers', offers(listed));
}

export async function describeSource(ctx: PalmContext, app: App, state: ScopeState, name: string) {
  const ref = state.sources.byName(name);
  if (!ref) {
    const near = nearest(name, state.sources.names());
    if (!near && looksLikeSourceInput(name)) return describeUndeclared(ctx, app, state, name);
    throw unknownSource(state, name, near);
  }
  const view = sourceView(state, ref);
  const scope = state.paths.scope;
  const listed = await engine(app)
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
  if (!ref.isLocal) field(out, 'ref', view.ref);
  const hash = view.sha ?? view.tree ?? listed?.checkout.sha ?? listed?.checkout.tree;
  field(out, ref.isLocal ? 'tree' : 'sha', shortHash(hash));
  field(out, 'root', root);
  const [first, ...more] = layoutLines(layout);
  field(out, 'layout', first);
  for (const line of more) out.out(`  ${' '.repeat(12)}${line}`);
  field(out, 'detected', detected);
  field(out, 'installed', String(view.entries));
  field(out, 'offers', offers(listed));
}

/** Global places are tokens (<claude>/skills); a person reads them as ~/.claude/skills. */
function readable(ctx: PalmContext, state: ScopeState) {
  return (where: string) =>
    where.replace(/<([a-z]+)>/g, (m, t: string) =>
      TOKEN_NAMES.has(t)
        ? displayPath(ctx, state.paths.token(t as TokenName), state.paths.scope)
        : m,
    );
}

export async function describeTarget(ctx: PalmContext, app: App, state: ScopeState, id: string) {
  const view = (await targetViews(app, ctx, state)).find((t) => t.id === id.toLowerCase());
  if (!view)
    throw usage(
      `"${id}" is not a target (${TARGET_IDS.join(', ')})`,
      palmLine('describe', ['target', 'claude'], state.paths.scope),
    );
  const target = await targetOf(app.deps ?? {}, view.id);
  const dirs = target.outputDirs(state.paths.scope, state.paths.root, ctx.env);
  const root = scopeRoot(ctx, state);
  if (app.out.jsonMode) return app.out.json({ ...view, root: state.paths.root, outputDirs: dirs });
  const out = app.out;
  out.out(`${out.colors.bold(`target ${view.id}`)}  (${view.name})`);
  const manifest = manifestFile(state.paths.scope);
  field(out, 'active', view.active ? 'yes' : `no (add it to targets: in ${manifest})`);
  field(out, 'root', root);
  field(out, 'config dir', view.configDir);
  const at = { scope: state.paths.scope, scopeRoot: state.paths.root, env: ctx.env };
  const scopeSet = await activeTargets(app, ctx, state);
  const active: TargetId[] = view.active ? scopeSet : [...scopeSet, view.id];
  const shown = readable(ctx, state);
  for (const p of target.placements?.(at, active) ?? []) field(out, p.kind, shown(p.where));
  field(out, 'writes to', dirs.map((d) => shown(displayLockPath(d))).join(', '));
}
