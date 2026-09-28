/**
 * The default dispatcher: one dynamic import per command, so a command's code (and the
 * engine, git, yaml and clack behind it) loads only when that command runs.
 */
import type { App, Runner } from './app.js';
import type { Invocation } from './grammar.js';

const RUNNERS: Readonly<Record<string, () => Promise<Runner>>> = {
  install: async () => (await import('./install.js')).run,
  uninstall: async () => (await import('./uninstall.js')).run,
  get: async () => (await import('./get.js')).run,
  describe: async () => (await import('./describe.js')).run,
  update: async () => (await import('./update.js')).run,
  create: async () => (await import('./create.js')).run,
  search: async () => (await import('./search.js')).run,
  init: async () => (await import('./init.js')).run,
  doctor: async () => (await import('./doctor.js')).run,
  outdated: async () => (await import('./outdated.js')).run,
  why: async () => (await import('./why.js')).run,
  find: async () => (await import('./find.js')).run,
  audit: async () => (await import('./audit.js')).run,
  config: async () => (await import('./config.js')).run,
  completion: async () => (await import('./completion.js')).run,
  cache: async () => (await import('./cache.js')).run,
};

export async function runInvocation(inv: Invocation, app: App): Promise<void> {
  const load = RUNNERS[inv.command.split(' ')[0] ?? ''];
  if (!load) throw new Error(`no runner for "${inv.command}"`);
  const run = await load();
  await run(inv, app);
}
