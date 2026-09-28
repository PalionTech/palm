/** Helpers every command module shares: options, scope, context, spinner, failure checks. */
import { relative, sep } from 'node:path';
import type { Resource } from '../core/kinds.js';
import {
  KINDS,
  type Kind,
  type PalmContext,
  type Scope,
  type SecretPolicy,
  TARGET_IDS,
  type TargetId,
  type UI,
} from '../core/types.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import type { App } from './app.js';
import { plural, usage } from './grammar.js';

export { failureCount } from '../ui/output.js';
export { ExitSignal, splitPassthrough, usage } from './grammar.js';

/** Options every command accepts (declared once on the root program). */
export interface GlobalOptions {
  global?: boolean;
  target?: string;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  offline?: boolean;
  verbose?: boolean;
  json?: boolean;
  color?: boolean;
}

export function scopeOf(g: GlobalOptions): Scope {
  return g.global ? 'global' : 'project';
}

/** Parse `claude,codex` into target ids; undefined when not given. */
export function parseTargetList(value: string | undefined): TargetId[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = ids.filter((id) => !(TARGET_IDS as readonly string[]).includes(id));
  if (bad.length)
    throw usage(
      `unknown target${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`,
      `valid targets: ${TARGET_IDS.join(', ')}`,
    );
  if (ids.length === 0)
    throw usage('--target needs at least one target', `valid targets: ${TARGET_IDS.join(', ')}`);
  return [...new Set(ids)] as TargetId[];
}

export function parseSecretPolicy(value: string | undefined): SecretPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === 'env-ref' || value === 'literal') return value;
  throw usage(`invalid secret policy "${value}"`, 'use env-ref or literal');
}

/** The entity kind a verb acts on, or undefined for "every kind"; origin/target/all are refused. */
export function entityKind(resource: Resource | undefined, verb: string): Kind | undefined {
  if (resource === undefined) return undefined;
  if ((KINDS as readonly string[]).includes(resource)) return resource as Kind;
  throw usage(`palm ${verb} does not take ${plural(resource)} here`);
}

async function defaultUI(g: GlobalOptions, env: NodeJS.ProcessEnv, interactive?: boolean) {
  const prompts = await import('../ui/prompts.js');
  const tty = interactive ?? prompts.isInteractiveTerminal(env);
  if (!tty) return prompts.createNonInteractiveUI();
  return prompts.createClackUI({ output: g.json ? process.stderr : undefined });
}

/** The PalmContext of one command: the writer as `ctx.log`, clack (or the app's UI) as `ctx.ui`. */
export async function makeContext(
  app: App,
  g: GlobalOptions,
  opts: { interactive?: boolean } = {},
): Promise<PalmContext> {
  const env = app.env ?? process.env;
  const ui: UI = app.ui ?? (await defaultUI(g, env, opts.interactive));
  const { createContext } = await import('../core/context.js');
  return createContext({
    cwd: app.cwd ?? process.cwd(),
    env,
    ui,
    log: app.out,
    flags: {
      yes: Boolean(g.yes),
      dryRun: Boolean(g.dryRun),
      force: Boolean(g.force),
      offline: Boolean(g.offline),
      verbose: Boolean(g.verbose),
    },
  });
}

/** Absolute directory scope-relative paths resolve against (projectRoot or home). */
export function scopeRootOf(ctx: PalmContext, scope: Scope): string {
  return ScopePaths.of(ctx, scope).root;
}

/** Show `p` relative to the project root (`./…`) or home (`~/…`) when it lives under one of them. */
export function displayPath(ctx: PalmContext, p: string): string {
  if (isWithin(p, ctx.paths.projectRoot))
    return `.${sep}${relative(ctx.paths.projectRoot, p)}`.replace(/[\\/]$/, '');
  if (isWithin(p, ctx.paths.home))
    return `~${sep}${relative(ctx.paths.home, p)}`.replace(/[\\/]$/, '');
  return p;
}

/** Run `fn` under a spinner (interactive, non-JSON only). */
export async function withSpinner<T>(
  ctx: PalmContext,
  step: { message: string; json?: boolean; done?: (v: T) => string },
  fn: () => Promise<T>,
): Promise<T> {
  const s = ctx.ui.isInteractive && !step.json ? ctx.ui.spinner(step.message) : undefined;
  try {
    const value = await fn();
    s?.stop(step.done ? step.done(value) : step.message);
    return value;
  } catch (e) {
    s?.stop(`${step.message} failed`);
    throw e;
  }
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/** "3 entries" / "1 entry". */
export function entries(n: number): string {
  return `${n} entr${n === 1 ? 'y' : 'ies'}`;
}
