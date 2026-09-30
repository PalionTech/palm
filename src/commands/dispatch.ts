/**
 * The default dispatcher: one dynamic import per command, so a command's code (and the
 * engine, git, yaml and clack behind it) loads only when that command runs. A palm 0.1 form
 * prints its new form first.
 */
import { PalmError } from '../core/errors.js';
import type { App, Runner } from './app.js';
import type { Invocation } from './grammar.js';

type Module = Promise<{ run: Runner }>;

const RUNNERS: Readonly<Record<string, () => Module>> = {
  init: () => import('./init.js'),
  install: () => import('./install.js'),
  'install mcp': () => import('./mcp.js'),
  remove: () => import('./remove.js'),
  update: () => import('./update.js'),
  check: () => import('./check.js'),
  get: () => import('./get.js'),
  describe: () => import('./describe.js'),
  create: () => import('./create.js'),
  migrate: () => import('./migrate.js'),
  completion: () => import('./completion.js'),
  'cache clean': () => import('./cache.js'),
};

export async function runInvocation(inv: Invocation, app: App): Promise<void> {
  if (inv.legacy) app.out.info(`${inv.legacy.form} is now: ${inv.legacy.replacement}`);
  const load = RUNNERS[inv.command];
  if (!load) throw new PalmError('E_INTERNAL', `no command module for "${inv.command}"`);
  const { run } = await load();
  await run(inv, app);
}
