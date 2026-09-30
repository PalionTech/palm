/**
 * `runCli(argv)`: parse, dispatch, print, and map the outcome to an exit code (DESIGN.md §6
 * "Exit codes"): 0 success, 1 failure, 2 usage, 130 cancelled. src/cli.ts only calls this and
 * exits; tests call it in process with string sinks, a fake UI and fake engine deps.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CommanderError } from 'commander';
import { isPalmError, messageOf, PalmError, retryHint } from '../core/errors.js';
import type { UI } from '../core/types.js';
import type { CliDeps } from '../create/engine.js';
import { redactTypedArgs } from '../secrets/typed.js';
import { publicHint } from '../ui/format.js';
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
import { shellWord } from './hints.js';
import { buildProgram, LEGACY_COMMAND_NAMES } from './program.js';

export const EXIT = { ok: 0, failure: 1, usage: 2, cancelled: 130 } as const;

/** The hint under an error palm did not expect. */
export const BUG_HINT = 'this is a palm bug; report it with --json output';

export interface CliOptions {
  version?: string;
  stdout?: Sink;
  stderr?: Sink;
  /** Where `install mcp --snippet -` reads (default: process.stdin). */
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
  /** Where it ran, to find the palm.yaml an error names (M13). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const COMMAND_WORDS = new Set([
  ...VERBS.flatMap((v) => [v.name, ...v.aliases]),
  'migrate',
  'completion',
  'cache',
  'help',
]);

/** Commander's own message as a usage error: `x unknown option '--bogus'` and where help is. */
function fromCommander(e: CommanderError, args: readonly string[]): PalmError {
  const [first = '', ...rest] = e.message.replace(/^error:\s*/, '').split('\n');
  const verb = args.find((a) => !a.startsWith('-'));
  const help = verb && COMMAND_WORDS.has(verb) ? `palm ${verb} --help` : 'palm --help';
  return usage(first, [...rest.filter(Boolean), `see: ${help}`].join('\n'));
}

/**
 * J6': a hint that repeats a typed word holding a space or a shell character (`--description
 * "Summarise a standup"`, `--layout 'skills=packages/*'`) repeats it quoted, as the shell needs it.
 */
function requoted(hint: string, args: readonly string[]): string {
  let out = hint;
  for (const word of new Set(args)) {
    const quoted = shellWord(word);
    if (quoted === word || out.includes(quoted)) continue;
    const bare = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<= )${bare}(?= |$)`, 'gm'), () => quoted);
  }
  return out;
}

function errorDoc(e: unknown, run: RunLine): { code: string; message: string; hint?: string } {
  if (!isPalmError(e)) return { code: 'E_INTERNAL', message: messageOf(e), hint: BUG_HINT };
  // J11: a repeated command line never carries a value the person typed for a secret.
  const safe = { args: redactTypedArgs(run.args), passthrough: run.passthrough };
  const raw = retryHint(e, safe) ?? (e.code === 'E_INTERNAL' ? BUG_HINT : undefined);
  const hint = raw === undefined ? undefined : publicHint(requoted(raw, safe.args));
  return hint ? { code: e.code, message: e.message, hint } : { code: e.code, message: e.message };
}

/** Q14: a JSON error's hint without the indentation the terminal gives it. */
function jsonDoc(doc: ReturnType<typeof errorDoc>) {
  if (!doc.hint) return doc;
  const hint = doc.hint
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  return { ...doc, hint };
}

const MARKER = /^(<{7}|={7}|>{7})( |$)/;

/** The first line of `file` that is a merge-conflict marker (1-based), if any. */
function markerLine(file: string): number | undefined {
  try {
    const i = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .findIndex((l) => MARKER.test(l));
    return i < 0 ? undefined : i + 1;
  } catch {
    return undefined;
  }
}

/** The palm.yaml an E_PARSE names: `~/.palm/palm.yaml` under -g, else the nearest one up from cwd. */
function manifestNamed(message: string, run: RunLine): string | undefined {
  if (!/palm\.yaml/.test(message)) return undefined;
  const env = run.env ?? process.env;
  const home = env.PALM_HOME ?? join(env.HOME ?? '', '.palm');
  if (message.includes('~/.palm/palm.yaml')) return join(home, 'palm.yaml');
  for (let dir = run.cwd ?? process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'palm.yaml'))) return join(dir, 'palm.yaml');
    if (dirname(dir) === dir) return undefined;
  }
}

/** M13: a palm.yaml parse error caused by merge-conflict markers says so, with the line. */
function conflictMarkers(e: unknown, run: RunLine): unknown {
  if (!isPalmError(e) || e.code !== 'E_PARSE') return e;
  const file = manifestNamed(e.message, run);
  const line = file ? markerLine(file) : undefined;
  if (!file || line === undefined) return e;
  const shown = e.message.includes('~/.palm/palm.yaml') ? '~/.palm/palm.yaml' : 'palm.yaml';
  return new PalmError(
    'E_PARSE',
    `${shown} has merge conflict markers at line ${line}; resolve them`,
    `keep one side of each conflict in ${shown}, then run: palm check`,
  );
}

/** Commander printed help itself (`--help`, or a command group without its subcommand). */
function helpShown(e: unknown): boolean {
  if (!(e instanceof CommanderError)) return false;
  return e.exitCode === 0 || e.code === 'commander.help' || e.message === '(outputHelp)';
}

/**
 * An interrupted install says how far it got (L11: `interrupted after 3 of 19; …`); a plain
 * cancel (Esc, a declined question) prints nothing more.
 */
function reportCancel(e: unknown, out: Output): void {
  if (!isPalmError(e) || e.message === 'cancelled' || out.jsonMode) return;
  out.info(e.message);
  if (e.hint) out.hint(`  ${e.hint}`);
}

/** Print what went wrong: warnings first, the error last; nothing for a cancel or an exit. */
function report(e: unknown, out: Output, run: RunLine): void {
  if (e instanceof ExitSignal) return;
  if (exitCodeFor(e) === EXIT.cancelled) {
    reportCancel(e, out);
    return;
  }
  if (helpShown(e)) return;
  const err = conflictMarkers(e instanceof CommanderError ? fromCommander(e, run.args) : e, run);
  const doc = errorDoc(err, run);
  if (out.jsonMode) {
    out.json({ error: jsonDoc(doc) });
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

/** C15: `palm help <word>` for a word that is no command is the error `palm <word>` gives. */
function unknownHelpTopic(args: readonly string[]): PalmError | undefined {
  const [first, topic] = args;
  if (first !== 'help' || topic === undefined || topic.startsWith('-')) return undefined;
  if (COMMAND_WORDS.has(topic) || LEGACY_COMMAND_NAMES.includes(topic)) return undefined;
  return usage(`unknown command '${topic}'`, 'see: palm --help');
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
    const unknownTopic = unknownHelpTopic(args);
    if (unknownTopic) throw unknownTopic;
    if (args.length === 0) program.outputHelp();
    else await program.parseAsync(args, { from: 'user' });
  } catch (e) {
    code = exitCodeFor(e);
    report(e, app.out, { args, passthrough, cwd: opts.cwd, env: opts.env });
  } finally {
    unwatch();
  }
  app.out.finish();
  return code;
}
