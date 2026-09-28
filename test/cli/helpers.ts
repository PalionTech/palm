/** Helpers for the CLI tests: a sandboxed `palm` (dist subprocess or in process) and captured streams. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CliOptions, runCli } from '../../src/commands/main.js';
import { runPalm } from '../support/cli.js';
import { type Sandbox, sandbox } from '../support/sandbox.js';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export interface CliSandbox extends Sandbox {
  /** `node dist/cli.js ...args` in the sandbox project, with a hermetic environment. */
  palm(...args: string[]): ReturnType<typeof runPalm>;
  /** Same, from another directory. */
  palmIn(cwd: string, ...args: string[]): ReturnType<typeof runPalm>;
  configFile: string;
}

export async function cliSandbox(): Promise<CliSandbox> {
  const sb = await sandbox();
  const env = {
    ...sb.env,
    NO_COLOR: '1',
    CI: '1',
    PATH: process.env.PATH,
    GIT_TERMINAL_PROMPT: '0',
  };
  const palmIn = (cwd: string, ...args: string[]) => runPalm(args, { cwd, env });
  return {
    ...sb,
    env,
    palm: (...args) => palmIn(sb.project, ...args),
    palmIn,
    configFile: join(sb.palmHome, 'config.yaml'),
  };
}

/** Register local origins in the sandbox's global config. */
export async function writeOrigins(
  sb: Sandbox,
  origins: Array<{ alias: string; fixture: string }>,
): Promise<void> {
  await mkdir(sb.palmHome, { recursive: true });
  const lines = origins.map(
    (o) => `  - { alias: ${o.alias}, type: local, path: ${join(FIXTURES, o.fixture)} }`,
  );
  await writeFile(join(sb.palmHome, 'config.yaml'), ['origins:', ...lines, ''].join('\n'));
}

export interface Captured {
  stdout: string;
  stderr: string;
  code: number;
}

/** `runCli` in process over string buffers. */
export async function runInProcess(
  argv: string[],
  opts: Omit<CliOptions, 'stdout' | 'stderr'> = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    ...opts,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { stdout, stderr, code };
}
