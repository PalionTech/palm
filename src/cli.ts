import { createRequire } from 'node:module';
import { CommanderError } from 'commander';
import pc from 'picocolors';
import { buildProgram } from './commands/program.js';
import { ExitSignal, isPalmError, printJson, splitPassthrough } from './commands/shared.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

async function main(argv: string[]): Promise<number> {
  const { args, passthrough } = splitPassthrough(argv);
  const verbose = args.includes('--verbose');
  const json = args.includes('--json');
  const program = buildProgram({ version, passthrough });
  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode; // commander already printed help/version/usage
    if (e instanceof ExitSignal) return e.exitCode;
    if (isPalmError(e)) {
      if (e.code === 'E_USAGE' && e.message === 'cancelled') return 1;
      // --json: the error is data too (code, message, hint) for scripts.
      if (json)
        printJson({
          error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) },
        });
      process.stderr.write(`${pc.red('error:')} ${e.message}\n`);
      if (e.hint) process.stderr.write(`${pc.dim(e.hint)}\n`);
      if (verbose && e.stack) process.stderr.write(`${pc.dim(e.stack)}\n`);
      return 1;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    process.stderr.write(`${pc.red('unexpected error:')} ${err.message}\n`);
    if (verbose && err.stack) process.stderr.write(`${pc.dim(err.stack)}\n`);
    else process.stderr.write(`${pc.dim('re-run with --verbose for a stack trace')}\n`);
    return 2;
  }
}

/** Exit only after stdout/stderr have drained (pipes are asynchronous on macOS). */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

exitAfterFlush(await main(process.argv.slice(2)));
