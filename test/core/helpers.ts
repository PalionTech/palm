import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext } from '../../src/core/context.js';
import { PalmError } from '../../src/core/errors.js';
import type { Logger, PalmContext, PickOption, UI } from '../../src/core/types.js';

export async function tempDir(prefix = 'palm-test-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

export interface FakeLogger extends Logger {
  messages: Array<{ level: string; msg: string }>;
}

export function fakeLogger(): FakeLogger {
  const messages: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => void messages.push({ level, msg });
  return { messages, info: push('info'), warn: push('warn'), debug: push('debug'), success: push('success') };
}

export interface FakeUI extends UI {
  picks: Array<{ message: string; options: PickOption<unknown>[] }>;
  pickManys: Array<{ message: string; options: PickOption<unknown>[] }>;
}

/** Interactive fake UI: `pick` returns the option chosen by `choose` (default: first). */
export function fakeUI(opts: {
  interactive?: boolean;
  choose?: (options: PickOption<unknown>[]) => unknown;
  chooseMany?: (options: PickOption<unknown>[]) => unknown[];
} = {}): FakeUI {
  const interactive = opts.interactive ?? true;
  const picks: FakeUI['picks'] = [];
  const pickManys: FakeUI['pickManys'] = [];
  const refuse = (): never => {
    throw new PalmError('E_NON_INTERACTIVE', 'prompt in non-interactive fake UI');
  };
  return {
    isInteractive: interactive,
    picks,
    pickManys,
    async pick<T>(message: string, options: PickOption<T>[]): Promise<T> {
      if (!interactive) refuse();
      picks.push({ message, options: options as PickOption<unknown>[] });
      return (opts.choose ? opts.choose(options as PickOption<unknown>[]) : options[0]!.value) as T;
    },
    async pickMany<T>(message: string, options: PickOption<T>[]): Promise<T[]> {
      if (!interactive) refuse();
      pickManys.push({ message, options: options as PickOption<unknown>[] });
      return (opts.chooseMany ? opts.chooseMany(options as PickOption<unknown>[]) : [options[0]!.value]) as T[];
    },
    async confirm(): Promise<boolean> {
      if (!interactive) refuse();
      return true;
    },
    async text(): Promise<string> {
      if (!interactive) refuse();
      return '';
    },
    async secret(): Promise<string> {
      if (!interactive) refuse();
      return 'secret';
    },
    spinner() {
      return { stop() {}, message() {} };
    },
  };
}

export interface Sandbox {
  root: string;
  home: string;
  palmHome: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

/** Temp HOME, PALM_HOME and a project dir (with .git) — never the real home. */
export async function sandbox(): Promise<Sandbox> {
  const root = await tempDir();
  const home = join(root, 'home');
  const palmHome = join(root, 'palm-home');
  const project = join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  return { root, home, palmHome, project, env: { HOME: home, PALM_HOME: palmHome } };
}

export async function makeContext(
  sb: Sandbox,
  opts: { ui?: UI; log?: Logger; flags?: Partial<PalmContext['flags']>; cwd?: string } = {},
): Promise<PalmContext> {
  return createContext({
    cwd: opts.cwd ?? sb.project,
    env: sb.env,
    ui: opts.ui ?? fakeUI(),
    log: opts.log ?? fakeLogger(),
    flags: { yes: false, dryRun: false, force: false, offline: false, verbose: false, ...opts.flags },
  });
}
