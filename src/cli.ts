import { createRequire } from 'node:module';
import { runCli } from './commands/main.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** Exit only after stdout/stderr have drained (pipes are asynchronous on macOS). */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

exitAfterFlush(await runCli(process.argv.slice(2), { version }));
