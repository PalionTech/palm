/** What every command module shares: the global flags, the context, the engine door, paths. */
import { isAbsolute, relative, sep } from 'node:path';
import type { PalmError } from '../core/errors.js';
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
import { redactTypedArgs } from '../secrets/typed.js';
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

/** The context of a CLI run always carries the command line (src/exec repeats it in its hints). */
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

/**
 * E7: `--local` arrives in 0.3. Without it the command is the same, except where it would only
 * narrow targets for a bare install: that change is an edit of targets: in palm.yaml.
 */
function localError(app: App, g: GlobalOptions & { targets?: string }): PalmError {
  const rest = app.argv.filter((a) => a !== '--local');
  const manifest = g.global ? '~/.palm/palm.yaml' : 'palm.yaml';
  const positional = rest.filter((a) => !a.startsWith('-') && a !== g.targets);
  if (g.targets !== undefined && positional.length <= 1)
    return usage(
      `palm.local.yaml arrives in palm 0.3; until then targets are shared in ${manifest}`,
      `add ${g.targets} to targets: in ${manifest}, then run: palm install${g.global ? ' -g' : ''}`,
    );
  return usage(
    'palm.local.yaml arrives in palm 0.3',
    `run it without --local: palm ${redactTypedArgs(rest).join(' ')}`,
  );
}

async function flagsOf(app: App, g: GlobalOptions): Promise<PalmFlags> {
  if (g.local) throw localError(app, g);
  const secrets = secretPolicy(g.secrets);
  // K-manifest: a server palm.yaml declares is keyed `@palm.yaml`; the lock still says manifest
  const typed = g.allowExec?.replaceAll('@palm.yaml=', '@manifest=');
  const allowExec = typed === undefined ? [] : await engine(app).parseAllowExec(typed);
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

/** The other scope's state (read only), to say where a name is installed; undefined when it cannot open. */
export async function otherScope(ctx: PalmContext, app: App, scope: Scope) {
  const other: Scope = scope === 'global' ? 'project' : 'global';
  return engine(app)
    .openScope(ctx, other, { readOnly: true })
    .catch(() => undefined);
}

/**
 * Q16: `it is installed in the global scope: palm <verb> <words> -g` when the other scope holds
 * one of `names`, else undefined (remove, get and describe say it the same way).
 */
export async function otherScopeHint(
  ctx: PalmContext,
  app: App,
  scope: Scope,
  line: { verb: string; words: string[]; names: ReadonlyArray<{ kind?: string; name: string }> },
): Promise<string | undefined> {
  const other = await otherScope(ctx, app, scope);
  const lower = (s: string) => s.toLowerCase();
  const hit = line.names.some((n) =>
    other?.lock.entries.some(
      (e) => lower(e.name) === lower(n.name) && (!n.kind || n.kind === e.kind),
    ),
  );
  if (!hit || !other) return undefined;
  const flip = other.paths.scope;
  const cmd = `palm ${[line.verb, ...line.words].join(' ')}${flip === 'global' ? ' -g' : ''}`;
  return `it is installed in the ${flip} scope: ${cmd}`;
}

/** `abs` relative to `root` with forward slashes, or undefined when it lies outside. */
function inside(root: string, abs: string): string | undefined {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    ? rel.split(sep).join('/')
    : undefined;
}

/** `abs` under home as `~/…` (J20, J24: people read home paths so), else absolute. */
export function homePath(ctx: PalmContext, abs: string): string {
  const home = inside(ctx.paths.home, abs);
  return home === undefined ? abs : `~/${home}`.replace(/\/$/, '');
}

/**
 * `abs` as a person reads it: relative to the project root, `~/…` under home, else absolute.
 * Under the global scope home comes first: nothing there is relative to a project.
 */
export function displayPath(ctx: PalmContext, abs: string, scope?: Scope): string {
  if (scope === 'global') return homePath(ctx, abs);
  const project = inside(ctx.paths.projectRoot, abs);
  if (project !== undefined) return project || '.';
  return homePath(ctx, abs);
}

/** The harness directories the scope's targets live in (`.claude/`, `~/.cursor/`). */
export async function targetDirs(app: App, ctx: PalmContext, state: ScopeState): Promise<string[]> {
  const dirs: string[] = [];
  for (const id of state.targets) {
    const target = await targetOf(app.deps ?? {}, id);
    const dir = target.configDir(state.paths.scope, state.paths.root, ctx.env);
    dirs.push(`${displayPath(ctx, dir, state.paths.scope)}/`);
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
