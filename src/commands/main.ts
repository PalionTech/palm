/**
 * `runCli(argv)`: parse, dispatch, print, and map the outcome to an exit code
 * (DESIGN.md §6): 0 success, 1 failure, 2 usage, 130 cancelled, 70 internal error.
 * src/cli.ts only calls this and exits; tests call it in process with fake streams and UI.
 */
import { CommanderError } from 'commander';
import { isPalmError } from '../core/errors.js';
import type { EngineDeps, UI } from '../core/types.js';
import { createOutput, type Output, type Sink } from '../ui/output.js';
import type { App } from './app.js';
import { runInvocation } from './dispatch.js';
import { type Dispatch, ExitSignal, splitPassthrough } from './grammar.js';
import { buildProgram } from './program.js';

export const EXIT = { ok: 0, failure: 1, usage: 2, internal: 70, cancelled: 130 } as const;

export interface CliOptions {
  version?: string;
  stdout?: Sink;
  stderr?: Sink;
  ui?: UI;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<EngineDeps>;
  /** Replace the command modules (grammar tests capture the Invocation instead). */
  dispatch?: Dispatch;
}

/** The exit code for an error a command threw. */
export function exitCodeFor(e: unknown): number {
  if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
  if (e instanceof ExitSignal) return e.exitCode;
  if (isPalmError(e)) {
    if (e.code === 'E_CANCELLED') return EXIT.cancelled;
    return e.code === 'E_USAGE' ? EXIT.usage : EXIT.failure;
  }
  return EXIT.internal;
}

function commanderMessage(e: CommanderError): string {
  return e.message.replace(/^error:\s*/, '');
}

function errorDoc(err: Error): Record<string, unknown> {
  const palm = isPalmError(err) ? err : undefined;
  const hint = palm?.hint ? { hint: palm.hint } : {};
  return { error: { code: palm?.code ?? 'E_INTERNAL', message: err.message, ...hint } };
}

function printError(out: Output, err: Error): void {
  out.finish(); // warnings first, the error last
  if (isPalmError(err)) out.error(err.message, err.hint);
  else {
    const hint = out.verbose ? undefined : 're-run with --verbose for a stack trace';
    out.error(`internal error: ${err.message}`, hint);
  }
  if (err.stack) out.debug(err.stack);
}

/** Print what went wrong (commander already printed its own usage errors). */
function report(e: unknown, out: Output, code: number): void {
  if (code === EXIT.ok || code === EXIT.cancelled || e instanceof ExitSignal) return;
  if (e instanceof CommanderError) {
    if (out.jsonMode) out.json({ error: { code: 'E_USAGE', message: commanderMessage(e) } });
    return;
  }
  const err = e instanceof Error ? e : new Error(String(e));
  if (out.jsonMode) out.json(errorDoc(err));
  else printError(out, err);
}

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const { args, passthrough } = splitPassthrough(argv);
  const out = createOutput({
    json: args.includes('--json'),
    verbose: args.includes('--verbose'),
    stdout: opts.stdout,
    stderr: opts.stderr,
  });
  const app: App = { out, passthrough, ui: opts.ui, cwd: opts.cwd, env: opts.env, deps: opts.deps };
  const program = buildProgram({
    version: opts.version,
    dispatch: opts.dispatch ?? ((inv) => runInvocation(inv, app)),
    ...(opts.stdout ? { writeOut: (s: string) => void opts.stdout?.write(s) } : {}),
    ...(opts.stderr ? { writeErr: (s: string) => void opts.stderr?.write(s) } : {}),
  });
  app.program = program;
  program.hook('preAction', (_root, action) => {
    const g = action.optsWithGlobals<{ json?: boolean; verbose?: boolean }>();
    out.configure({ json: Boolean(g.json), verbose: Boolean(g.verbose) });
  });
  if (args.length === 0) {
    program.outputHelp();
    return EXIT.ok;
  }
  let code: number = EXIT.ok;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (e) {
    code = exitCodeFor(e);
    report(e, out, code);
  }
  out.finish();
  return code;
}
