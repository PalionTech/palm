/**
 * `runCli(argv)`: parse, dispatch, print, and map the outcome to an exit code (DESIGN.md §6
 * "Exit codes"): 0 success, 1 failure, 2 usage, 130 cancelled. src/cli.ts only calls this and
 * exits; tests call it in process with string sinks, a fake UI and fake engine deps.
 */
import { CommanderError } from 'commander';
import { isPalmError, messageOf, type PalmError, retryHint } from '../core/errors.js';
import type { UI } from '../core/types.js';
import type { CliDeps } from '../create/engine.js';
import { createOutput, type Output, type Sink } from '../ui/output.js';
import type { App } from './app.js';
import { runInvocation } from './dispatch.js';
import {
  applyPassthrough,
  type Dispatch,
  ExitSignal,
  type Invocation,
  prepareArgv,
  usage,
  VERBS,
} from './grammar.js';
import { buildProgram } from './program.js';

export const EXIT = { ok: 0, failure: 1, usage: 2, cancelled: 130 } as const;

/** The hint under an error palm did not expect. */
export const BUG_HINT = 'this is a palm bug; report it with --json output';

export interface CliOptions {
  version?: string;
  stdout?: Sink;
  stderr?: Sink;
  /** Where `install mcp --json -` reads (default: process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** stdout is a terminal (colour, pager). Default: process.stdout.isTTY when no stdout is given. */
  isTTY?: boolean;
  ui?: UI;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Engine collaborators and fakes of engine operations (`CliDeps`). */
  deps?: CliDeps;
  /** Replace the command modules (grammar tests capture the Invocation instead). */
  dispatch?: Dispatch;
  /** src/cli.ts: how to end the process at once. Given, runCli handles Ctrl-C (SIGINT). */
  exit?: (code: number) => void;
}

/** The exit code for what a command threw. */
export function exitCodeFor(e: unknown): number {
  if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
  if (e instanceof ExitSignal) return e.exitCode;
  if (isPalmError(e) && e.code === 'E_CANCELLED') return EXIT.cancelled;
  if (isPalmError(e) && e.code === 'E_USAGE') return EXIT.usage;
  return EXIT.failure;
}

/** The command line that failed, for hints that repeat it (`PalmError.retryWith`). */
interface RunLine {
  args: readonly string[];
  passthrough: readonly string[];
}

const COMMAND_WORDS = new Set([
  ...VERBS.flatMap((v) => [v.name, ...v.aliases]),
  'migrate',
  'completion',
  'cache',
]);

/** Commander's own message as a usage error: `x unknown option '--bogus'` and where help is. */
function fromCommander(e: CommanderError, args: readonly string[]): PalmError {
  const [first = '', ...rest] = e.message.replace(/^error:\s*/, '').split('\n');
  const verb = args.find((a) => !a.startsWith('-'));
  const help = verb && COMMAND_WORDS.has(verb) ? `palm ${verb} --help` : 'palm --help';
  return usage(first, [...rest.filter(Boolean), `see: ${help}`].join('\n'));
}

function errorDoc(e: unknown, run: RunLine): { code: string; message: string; hint?: string } {
  if (!isPalmError(e)) return { code: 'E_INTERNAL', message: messageOf(e), hint: BUG_HINT };
  const hint = retryHint(e, run) ?? (e.code === 'E_INTERNAL' ? BUG_HINT : undefined);
  return hint ? { code: e.code, message: e.message, hint } : { code: e.code, message: e.message };
}

/** Print what went wrong: warnings first, the error last; nothing for a cancel or an exit. */
function report(e: unknown, out: Output, run: RunLine): void {
  if (e instanceof ExitSignal || exitCodeFor(e) === EXIT.cancelled) return;
  if (e instanceof CommanderError && e.exitCode === 0) return;
  const err = e instanceof CommanderError ? fromCommander(e, run.args) : e;
  const doc = errorDoc(err, run);
  if (out.jsonMode) {
    out.json({ error: doc });
    return;
  }
  out.finish();
  out.error(doc.message, doc.hint);
  if (!isPalmError(err) && err instanceof Error && err.stack) out.debug(err.stack);
}

/** The first Ctrl-C during an install stops after the current entity; any other ends palm. */
function watchInterrupts(app: App, exit: (code: number) => void): () => void {
  const onSigint = () => {
    if (!app.onInterrupt || app.interrupted) return exit(EXIT.cancelled);
    app.interrupted = true;
    app.onInterrupt();
    app.out.hint('stopping after the current entity; press Ctrl-C again to quit now');
  };
  process.on('SIGINT', onSigint);
  return () => {
    process.off('SIGINT', onSigint);
  };
}

function makeApp(args: string[], passthrough: string[], opts: CliOptions): App {
  const env = opts.env ?? process.env;
  const out = createOutput({
    json: args.includes('--json'),
    stdout: opts.stdout,
    stderr: opts.stderr,
    isTTY: opts.isTTY ?? (!opts.stdout && Boolean(process.stdout.isTTY)),
    noColor: Boolean(env.NO_COLOR),
    debug: env.PALM_DEBUG === '1',
  });
  const { stdin, ui, cwd, deps } = opts;
  return { out, stdin, ui, cwd, env: opts.env, deps, argv: args, passthrough };
}

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const { args, passthrough } = prepareArgv(argv);
  const app = makeApp(args, passthrough, opts);
  const run = opts.dispatch ?? ((inv: Invocation) => runInvocation(inv, app));
  const program = buildProgram({
    version: opts.version,
    dispatch: (inv) => run(applyPassthrough(inv, passthrough)),
    writeOut: (text) => void (opts.stdout ?? process.stdout).write(text),
    writeErr: (text) => void (opts.stderr ?? process.stderr).write(text),
  });
  app.program = program;
  program.hook('preAction', (_root, action) => {
    app.out.configure({ json: Boolean(action.optsWithGlobals().json) });
  });
  const unwatch = opts.exit ? watchInterrupts(app, opts.exit) : () => undefined;
  let code: number = EXIT.ok;
  try {
    if (args.length === 0) program.outputHelp();
    else await program.parseAsync(args, { from: 'user' });
  } catch (e) {
    code = exitCodeFor(e);
    report(e, app.out, { args, passthrough });
  } finally {
    unwatch();
  }
  app.out.finish();
  return code;
}
