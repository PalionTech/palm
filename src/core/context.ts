import { OriginSet } from '../domain/origin-set.js';
import { loadConfig, loadProjectOrigins } from './config-file.js';
import { resolvePaths } from './paths.js';
import type { Logger, OriginSpec, PalmConfig, PalmContext, UI } from './types.js';

export interface ContextInit {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ui: UI;
  log: Logger;
  flags: PalmContext['flags'];
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Backs `ctx.origins`. User origins always come from `ctx.config.origins`; the project's palm.yaml
 * is read once, on first use (so a bad alias there fails the commands that use origins, not
 * `palm doctor` or `palm config`). The set is rebuilt only when `ctx.config.origins` changed.
 */
class ContextOrigins {
  private project: readonly OriginSpec[] | undefined;
  private built: { set: OriginSet; from: readonly OriginSpec[] } | undefined;
  private readonly ctx: Omit<PalmContext, 'origins'>;

  constructor(ctx: Omit<PalmContext, 'origins'>) {
    this.ctx = ctx;
  }

  get(): OriginSet {
    const user = this.ctx.config.origins;
    if (this.built && sameItems(user, this.built.from)) return this.built.set;
    this.project ??= loadProjectOrigins(this.ctx.paths, this.ctx.log);
    const set = OriginSet.of(user).withProject(this.project);
    this.built = { set, from: [...user] };
    return set;
  }

  /** Adopt `project` as the project layer, or re-read palm.yaml on next use (`reload`). */
  setProject(project: readonly OriginSpec[] | 'reload'): void {
    this.project = project === 'reload' ? undefined : project;
    this.built = undefined;
  }
}

const STATE = new WeakMap<object, ContextOrigins>();

function withOrigins(base: Omit<PalmContext, 'origins'>): PalmContext {
  const state = new ContextOrigins(base);
  const ctx = Object.defineProperty(base, 'origins', {
    enumerable: true,
    configurable: true,
    get: (): OriginSet => state.get(),
    set: (next: OriginSet): void => state.setProject(next.projectSpecs()),
  }) as PalmContext;
  STATE.set(ctx, state);
  return ctx;
}

/** Build the context for one command. Reads config (defaults when missing); writes nothing. */
export async function createContext(init: ContextInit): Promise<PalmContext> {
  const paths = resolvePaths(init.cwd, init.env);
  const config = await loadConfig(paths);
  return withOrigins({
    paths,
    config,
    ui: init.ui,
    log: init.log,
    env: init.env,
    flags: { ...init.flags },
  });
}

/**
 * The one place a context's origin state changes, after config.yaml or palm.yaml was saved:
 * `config` replaces `ctx.config` (never mutated in place), `project` the project origins
 * (`reload` re-reads palm.yaml on next use). `ctx.origins` reflects both.
 */
export function refreshOrigins(
  ctx: PalmContext,
  change: { config?: PalmConfig; project?: readonly OriginSpec[] | 'reload' },
): void {
  if (change.config) ctx.config = change.config;
  const state = STATE.get(ctx);
  if (state) {
    if (change.project) state.setProject(change.project);
    return;
  }
  // A context built by hand (tests) or copied with a spread: rebuild its plain `origins` value.
  const project =
    change.project && change.project !== 'reload'
      ? change.project
      : (ctx.origins?.projectSpecs() ?? []);
  ctx.origins = OriginSet.of(ctx.config.origins).withProject(project);
}
