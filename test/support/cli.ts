/** Spawns the built CLI (`node dist/cli.js`); dist/ is built once by build-dist.ts. */
import { execa } from 'execa';
import { inject } from 'vitest';

/**
 * Absolute path of dist/cli.js, provided by the globalSetup after a successful build.
 * @public
 */
export function palmCli(): string {
  return inject('palmCli');
}

/** Runs `node dist/cli.js ...args`; never rejects on a non-zero exit. */
export function runPalm(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execa(process.execPath, [palmCli(), ...args], { reject: false, ...opts });
}
