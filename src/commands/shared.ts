import { relative, sep } from 'node:path';
import { Command } from 'commander';
import { PalmError } from '../core/errors.js';
import { parseKind } from '../core/kinds.js';
import {
  KINDS,
  type Kind,
  type PalmContext,
  type Scope,
  type SecretPolicy,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { isWithin } from '../lib/fs.js';
import { stringifyJson } from '../lib/json.js';
import { createLogger } from '../ui/output.js';
import { createClackUI, createNonInteractiveUI, isInteractiveTerminal } from '../ui/prompts.js';

/** For src/cli.ts, which may import only src/commands and src/ui (moves to the output writer in wave 3). */
export { isPalmError } from '../core/errors.js';

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
}

/** Thrown by a command to end the process with a given exit code after it has printed its own output. */
export class ExitSignal extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'ExitSignal';
    this.exitCode = exitCode;
  }
}

/**
 * Root `palm` command with global options and shared settings, but no subcommands.
 * `exitOverride` is set before subcommands are added so they inherit it: commander throws
 * `CommanderError` instead of calling process.exit (src/cli.ts maps it to an exit code).
 */
export function createRootProgram(): Command {
  return new Command('palm')
    .exitOverride()
    .description(
      'Package manager for agent resources: skills, agents, instructions, commands, hooks, MCP servers and plugins.',
    )
    .option('-g, --global', 'use the global scope (~) instead of the current project')
    .option('-t, --target <ids>', 'comma-separated targets: claude,codex,copilot,cursor')
    .option('--dry-run', 'show what would change without writing anything')
    .option('--force', 'overwrite files palm does not own')
    .option('-y, --yes', 'accept defaults instead of prompting')
    .option('--offline', 'use cached origins only; no network')
    .option('--verbose', 'debug output and stack traces')
    .option('--json', 'machine-readable output on stdout')
    .configureHelp({ showGlobalOptions: true, sortSubcommands: false })
    .showSuggestionAfterError(true);
}

/** Split argv at the first `--`: everything after it is a pass-through command (ad hoc MCP servers). */
export function splitPassthrough(argv: string[]): { args: string[]; passthrough: string[] } {
  const i = argv.indexOf('--');
  if (i === -1) return { args: argv, passthrough: [] };
  return { args: argv.slice(0, i), passthrough: argv.slice(i + 1) };
}

export function usage(message: string, hint?: string): PalmError {
  return new PalmError('E_USAGE', message, hint);
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

/** Parse a kind word, throwing a usage error listing valid kinds. */
export function requireKind(word: string, allowed: readonly Kind[] = KINDS): Kind {
  const kind = parseKind(word);
  if (!kind || !allowed.includes(kind)) {
    throw usage(
      `"${word}" is not a kind palm understands here`,
      `use one of: ${allowed.join(', ')}`,
    );
  }
  return kind;
}

/** `[kind] names...`: shift the first word off when it parses as a kind. */
export function splitKindArgs(args: string[]): { kind?: Kind; rest: string[] } {
  const kind = parseKind(args[0]);
  return kind ? { kind, rest: args.slice(1) } : { kind: undefined, rest: [...args] };
}

/** Split `name[@origin][#ref]` without touching the ref (used for uninstall/info lookups). */
export function splitNameOrigin(spec: string): { name: string; origin?: string } {
  const noRef = spec.split('#')[0] ?? spec;
  const at = noRef.lastIndexOf('@');
  if (at > 0 && !noRef.slice(at + 1).includes('/'))
    return { name: noRef.slice(0, at), origin: noRef.slice(at + 1) };
  return { name: noRef };
}

export async function makeContext(
  g: GlobalOptions,
  opts: { interactive?: boolean } = {},
): Promise<PalmContext> {
  const log = createLogger({ verbose: Boolean(g.verbose), json: Boolean(g.json) });
  const interactive = opts.interactive ?? isInteractiveTerminal(process.env);
  const ui = interactive
    ? createClackUI({ output: g.json ? process.stderr : undefined })
    : createNonInteractiveUI();
  const { createContext } = await import('../core/context.js');
  return createContext({
    cwd: process.cwd(),
    env: process.env,
    ui,
    log,
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
  return scope === 'global' ? ctx.paths.home : ctx.paths.projectRoot;
}

/** Show `p` relative to the project root (`./…`) or home (`~/…`) when it lives under one of them. */
export function displayPath(ctx: PalmContext, p: string): string {
  if (isWithin(p, ctx.paths.projectRoot))
    return `.${sep}${relative(ctx.paths.projectRoot, p)}`.replace(/[\\/]$/, '');
  if (isWithin(p, ctx.paths.home))
    return `~${sep}${relative(ctx.paths.home, p)}`.replace(/[\\/]$/, '');
  return p;
}

export function printJson(value: unknown): void {
  process.stdout.write(stringifyJson(value));
}

/** Collect a repeatable option into an array. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Run `fn` under a spinner (interactive, non-JSON only). */
export async function withSpinner<T>(
  ctx: PalmContext,
  g: GlobalOptions,
  message: string,
  fn: () => Promise<T>,
  done?: (v: T) => string,
): Promise<T> {
  const s = ctx.ui.isInteractive && !g.json ? ctx.ui.spinner(message) : undefined;
  try {
    const value = await fn();
    s?.stop(done ? done(value) : message);
    return value;
  } catch (e) {
    s?.stop(`${message} failed`);
    throw e;
  }
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}
