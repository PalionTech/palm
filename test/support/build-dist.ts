/**
 * vitest `globalSetup`: builds dist/ once per run with tsdown, so CLI tests exercise the
 * bundle that ships (`node dist/cli.js`), not the TypeScript sources through tsx.
 *
 * - `PALM_TEST_DIST=<dir>` builds into `<repo>/<dir>` instead (one level below the repo, so the
 *   bundle still finds `../package.json`), leaving dist/ alone for whatever else reads it.
 * - `PALM_SKIP_DIST_BUILD=1` builds nothing and tests the bundle already there.
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execa } from 'execa';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path of the freshly built CLI entry (dist/cli.js). */
    palmCli: string;
  }
}

const repo = resolve(import.meta.dirname, '../..');

export default async function setup(project: TestProject): Promise<void> {
  const outDir = basename(process.env.PALM_TEST_DIST || 'dist');
  const cli = resolve(repo, outDir, 'cli.js');
  if (process.env.PALM_SKIP_DIST_BUILD === '1') {
    if (!existsSync(cli)) throw new Error(`PALM_SKIP_DIST_BUILD=1 but ${cli} does not exist`);
  } else {
    const r = await execa(resolve(repo, 'node_modules/.bin/tsdown'), ['--out-dir', outDir], {
      cwd: repo,
      reject: false,
      all: true,
    });
    if (r.exitCode !== 0) throw new Error(`tsdown build failed (exit ${r.exitCode}):\n${r.all}`);
  }
  project.provide('palmCli', cli);
}
