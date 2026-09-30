/**
 * `palm install` (aliases `add`, `i`), DESIGN.md §6 and PLAN.md §4.9:
 *
 * - `palm install <source>`: fetch, index and list what it offers; save nothing;
 * - `palm install <source> [kind:]name... | --all`: install, recording the source and the
 *   entries in palm.yaml and the lock;
 * - `palm install`: make the disk match palm.yaml and the lock.
 *
 * `palm install mcp …` is src/commands/mcp.ts.
 */
import type { Entity, EntityRefSpec, InstallRequest, PalmContext } from '../core/types.js';
import type { ScopeState, SourceListing } from '../create/engine.js';
import type { App } from './app.js';
import { type Invocation, interpretInstall, usage } from './grammar.js';
import { listingJson, printListing } from './listing.js';
import { interruptible, reportInstall } from './report.js';
import {
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  parseTargetList,
  scopeOf,
  withSpinner,
} from './shared.js';

interface InstallFlags extends GlobalOptions {
  all?: boolean;
  as?: string;
  targets?: string;
  at?: string;
}

interface NamedInstall {
  before: ScopeState;
  source: string;
  names: EntityRefSpec[];
  flags: InstallFlags;
}

/** `isExecutable` for every entity of a listing, asked once each. */
async function executables(app: App, entities: Entity[]): Promise<(e: Entity) => boolean> {
  const api = engine(app);
  const found = new Set<Entity>();
  for (const e of entities) if (await api.isExecutable(e)) found.add(e);
  return (e) => found.has(e);
}

async function list(ctx: PalmContext, app: App, input: string, before: ScopeState) {
  const api = engine(app);
  const scope = before.paths.scope;
  const listed: SourceListing = await withSpinner(ctx, `Fetching ${input}`, () =>
    api.listSource(ctx, input, { scope }, engineDeps(app)),
  );
  const executable = await executables(app, listed.index.entities);
  for (const w of listed.index.warnings) app.out.warn(w);
  if (app.out.jsonMode) app.out.json(listingJson(listed, executable));
  else printListing(app.out, listed, executable);
}

function requestOf(job: NamedInstall): InstallRequest & { as?: string } {
  const { flags } = job;
  const targets = parseTargetList(flags.targets, '--targets');
  return {
    source: job.source,
    names: job.names,
    ...(flags.all ? { all: true } : {}),
    ...(targets ? { targets } : {}),
    ...(flags.at ? { at: flags.at } : {}),
    ...(flags.as ? { as: flags.as } : {}),
  };
}

async function installNames(ctx: PalmContext, app: App, job: NamedInstall): Promise<void> {
  const api = engine(app);
  const scope = job.before.paths.scope;
  const req = requestOf(job);
  const result = await interruptible(app, () =>
    api.installFromSource(ctx, req, { scope }, engineDeps(app)),
  );
  const after = await api.openScope(ctx, scope, { readOnly: true });
  await reportInstall(ctx, app, result, { before: job.before, after, from: job.names.length > 0 });
}

async function sync(ctx: PalmContext, app: App, before: ScopeState): Promise<void> {
  const api = engine(app);
  const scope = before.paths.scope;
  const result = await interruptible(app, () => api.syncScope(ctx, { scope }, engineDeps(app)));
  const after = await api.openScope(ctx, scope, { readOnly: true });
  if (!result.outcomes.length && !result.failures.length && !app.out.jsonMode) {
    app.out.info('nothing to install: palm.yaml lists no entries');
    app.out.hint('see what a source offers: palm install <owner/repo>');
  }
  await reportInstall(ctx, app, result, { before, after });
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as InstallFlags;
  const words = inv.words ?? [];
  if (!words.length && flags.all)
    throw usage(
      '--all needs the source to take everything from',
      'palm install obra/superpowers --all',
    );
  const ctx = await makeContext(app, flags);
  const before = await engine(app).openScope(ctx, scopeOf(flags), { readOnly: true });
  if (!words.length) return sync(ctx, app, before);
  const isDeclared = (word: string) => before.sources.byName(word) !== undefined;
  const w = interpretInstall(words, { isDeclared });
  const source = w.source ?? '';
  if (!w.names.length && !flags.all) return list(ctx, app, source, before);
  return installNames(ctx, app, { before, source, names: w.names, flags });
}
