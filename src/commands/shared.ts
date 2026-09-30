/** What every command module shares: the global flags, the context, the engine door, paths. */
import { isAbsolute, relative, sep } from 'node:path';
import {
  type EngineDeps,
  type PalmContext,
  type PalmFlags,
  type Scope,
  type SecretPolicy,
  TARGET_IDS,
  type TargetId,
  type UI,
} from '../core/types.js';
import {
  type Engine,
  engineDepsOf,
  engineOf,
  type ScopeState,
  targetOf,
} from '../create/engine.js';
import type { App } from './app.js';
import { usage } from './grammar.js';

/** The global flags (DESIGN.md §10), as commander hands them to every command. */
export interface GlobalOptions {
  global?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  allowExec?: string;
  offline?: boolean;
  json?: boolean;
  secrets?: string;
  local?: boolean;
  /** `install --review`: src/exec prints every program's scripts before it asks. */
  review?: boolean;
}

/**
 * What the CLI adds to the contract's flags and context (reported for types.ts): `review`, and
 * the command line src/exec repeats in the `review:` line of its no-terminal consent error.
 */
export type CliFlags = PalmFlags & { review?: boolean };
export type CliContext = PalmContext & { argv: readonly string[] };

export function scopeOf(g: GlobalOptions): Scope {
  return g.global ? 'global' : 'project';
}

/** The engine operations of this run (fakes from `CliOptions.deps` in tests). */
export function engine(app: App): Engine {
  return engineOf(app.deps);
}

/** The engine collaborators of this run, passed into every engine call. */
export function engineDeps(app: App): Partial<EngineDeps> {
  return engineDepsOf(app.deps);
}

/** Parse `claude,codex` into target ids; undefined when the flag was not given. */
export function parseTargetList(
  value: string | undefined,
  flag = '--target',
): TargetId[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = ids.filter((id) => !(TARGET_IDS as readonly string[]).includes(id));
  if (bad.length || ids.length === 0)
    throw usage(
      bad.length ? `unknown target: ${bad.join(', ')}` : `${flag} needs at least one target`,
      `${flag} ${TARGET_IDS.join(',')}   (any of these)`,
    );
  return [...new Set(ids)] as TargetId[];
}

function secretPolicy(value: string | undefined): SecretPolicy | undefined {
  if (value === undefined || value === 'env-ref' || value === 'literal') return value;
  throw usage(`--secrets takes env-ref or literal, not "${value}"`, '--secrets env-ref');
}

async function flagsOf(app: App, g: GlobalOptions): Promise<CliFlags> {
  if (g.local)
    throw usage(
      'palm.local.yaml arrives in palm 0.3',
      `run it without --local: palm ${app.argv.filter((a) => a !== '--local').join(' ')}`,
    );
  const secrets = secretPolicy(g.secrets);
  const allowExec = g.allowExec === undefined ? [] : await engine(app).parseAllowExec(g.allowExec);
  return {
    yes: Boolean(g.yes),
    dryRun: Boolean(g.dryRun),
    force: Boolean(g.force),
    offline: Boolean(g.offline),
    json: Boolean(g.json),
    allowExec,
    local: false,
    ...(secrets ? { secrets } : {}),
    ...(g.review ? { review: true } : {}),
  };
}

async function defaultUI(g: GlobalOptions, env: NodeJS.ProcessEnv): Promise<UI> {
  const prompts = await import('../ui/prompts.js');
  if (!prompts.isInteractiveTerminal(env)) return prompts.createNonInteractiveUI();
  return prompts.createClackUI(g.json ? { output: process.stderr } : {});
}

/**
 * The context of one command: the writer as `ctx.log`, clack (or the app's UI) as `ctx.ui`, and
 * `ctx.argv`, the command line as typed.
 */
export async function makeContext(app: App, g: GlobalOptions): Promise<CliContext> {
  const env = app.env ?? process.env;
  const flags = await flagsOf(app, g);
  const ui = app.ui ?? (await defaultUI(g, env));
  const { createContext } = await import('../core/context.js');
  const ctx = await createContext({ cwd: app.cwd ?? process.cwd(), env, ui, log: app.out, flags });
  const tail = app.passthrough.length ? ['--', ...app.passthrough] : [];
  return Object.assign(ctx, { argv: [...app.argv, ...tail] });
}

/** `abs` as a person reads it: relative to the project root, `~/…` under home, else absolute. */
export function displayPath(ctx: PalmContext, abs: string): string {
  const inside = (root: string) => {
    const rel = relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel : undefined;
  };
  const project = inside(ctx.paths.projectRoot);
  if (project !== undefined) return project.split(sep).join('/') || '.';
  const home = inside(ctx.paths.home);
  if (home !== undefined) return `~/${home.split(sep).join('/')}`.replace(/\/$/, '');
  return abs;
}

/** The harness directories the scope's targets live in (`.claude/`, `~/.cursor/`). */
export async function targetDirs(app: App, ctx: PalmContext, state: ScopeState): Promise<string[]> {
  const dirs: string[] = [];
  for (const id of state.targets) {
    const target = await targetOf(app.deps ?? {}, id);
    const dir = target.configDir(state.paths.scope, state.paths.root, ctx.env);
    dirs.push(`${displayPath(ctx, dir)}/`);
  }
  return dirs;
}

/** Run `fn` under a spinner (a terminal, not --json); the line is cleared when it ends. */
export async function withSpinner<T>(
  ctx: PalmContext,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const s = ctx.ui.isInteractive && !ctx.flags.json ? ctx.ui.spinner(message) : undefined;
  try {
    return await fn();
  } finally {
    s?.stop();
  }
}
