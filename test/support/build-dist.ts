/**
 * vitest `globalSetup`: builds dist/ once per run with tsdown, so CLI tests exercise the
 * bundle that ships (`node dist/cli.js`), not the TypeScript sources through tsx.
 */
import { resolve } from 'node:path';
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
  const r = await execa(resolve(repo, 'node_modules/.bin/tsdown'), [], {
    cwd: repo,
    reject: false,
    all: true,
  });
  if (r.exitCode !== 0) throw new Error(`tsdown build failed (exit ${r.exitCode}):\n${r.all}`);
  project.provide('palmCli', resolve(repo, 'dist/cli.js'));
}
