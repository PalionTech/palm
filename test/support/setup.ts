/**
 * vitest `setupFiles`: runs in every worker before each test file and makes the process
 * environment hermetic, so no test can read or write the developer's real home, harness
 * directories, git configuration, tokens or the network.
 *
 * - HOME, the harness config dirs and XDG_CONFIG_HOME point into a fresh temp dir.
 * - PALM_HOME stays the unusable sentinel from vitest.config.ts: a test that forgets to pass
 *   its own PALM_HOME fails loudly instead of silently sharing state.
 * - Global and system git config are disabled; git never prompts.
 * - Tokens and git repository overrides are removed.
 * - Global `fetch` is blocked; tests inject `fetchImpl` (or a fake) instead. A test that
 *   reaches the global fetch fails even if the code under test swallowed the error.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

export const PALM_HOME_SENTINEL = '/nonexistent-palm-home-set-per-test';

const workerId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0';
const root = realpathSync(mkdtempSync(join(tmpdir(), `palm-test-worker-${workerId}-`)));
const home = join(root, 'home');
mkdirSync(home, { recursive: true });

const set: Record<string, string> = {
  HOME: home,
  PALM_HOME: PALM_HOME_SENTINEL,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'),
  COPILOT_HOME: join(home, '.copilot'),
  XDG_CONFIG_HOME: join(home, '.config'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  CI: '1',
};
const unset = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
];

Object.assign(process.env, set);
for (const name of unset) delete process.env[name];

const blockedFetchCalls: string[] = [];
const urlOf = (input: string | URL | Request): string => {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
};
const blockedFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = urlOf(input);
  blockedFetchCalls.push(url);
  throw new Error(`network disabled in tests; inject fetchImpl (fetch ${url})`);
};
globalThis.fetch = blockedFetch as typeof fetch;

afterEach(() => {
  if (blockedFetchCalls.length === 0) return;
  const urls = blockedFetchCalls.splice(0).join(', ');
  throw new Error(`test called the global fetch (${urls}); inject fetchImpl or a fake instead`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
