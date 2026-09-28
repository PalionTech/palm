/**
 * Fakes shared by all tests: a recording logger, a scripted UI, a PalmContext over a
 * sandbox, and fake harness targets that write one marker file per entity.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createContext } from '../../src/core/context.js';
import { PalmError } from '../../src/core/errors.js';
import { hashPath } from '../../src/core/hash.js';
import type {
  DeployInput,
  LockEntry,
  Logger,
  PalmContext,
  PickOption,
  Scope,
  Target,
  TargetId,
  UI,
} from '../../src/core/types.js';
import type { Sandbox } from './sandbox.js';

export interface FakeLogger extends Logger {
  messages: Array<{ level: string; msg: string }>;
}

export function fakeLogger(): FakeLogger {
  const messages: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => void messages.push({ level, msg });
  return {
    messages,
    info: push('info'),
    warn: push('warn'),
    debug: push('debug'),
    success: push('success'),
  };
}

export interface FakeUI extends UI {
  picks: Array<{ message: string; options: PickOption<unknown>[] }>;
  pickManys: Array<{ message: string; options: PickOption<unknown>[] }>;
}

/** Interactive fake UI: `pick` returns the option chosen by `choose` (default: first). */
export function fakeUI(
  opts: {
    interactive?: boolean;
    choose?: (options: PickOption<unknown>[]) => unknown;
    chooseMany?: (options: PickOption<unknown>[]) => unknown[];
  } = {},
): FakeUI {
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
      return (
        opts.chooseMany ? opts.chooseMany(options as PickOption<unknown>[]) : [options[0]!.value]
      ) as T[];
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

export async function makeContext(
  sb: Sandbox,
  opts: { ui?: UI; log?: Logger; flags?: Partial<PalmContext['flags']>; cwd?: string } = {},
): Promise<PalmContext> {
  return createContext({
    cwd: opts.cwd ?? sb.project,
    env: sb.env,
    ui: opts.ui ?? fakeUI(),
    log: opts.log ?? fakeLogger(),
    flags: {
      yes: false,
      dryRun: false,
      force: false,
      offline: false,
      verbose: false,
      ...opts.flags,
    },
  });
}

export interface TargetCalls {
  deploy: Array<{ id: TargetId; input: DeployInput }>;
  undeploy: Array<{ id: TargetId; entry: LockEntry; dryRun: boolean }>;
}

/** Targets that write `.<id>/<kind>/<name>.txt` under the scope root. */
export function fakeTargets(opts: { detect?: TargetId[]; failFor?: TargetId[] } = {}): {
  calls: TargetCalls;
  getTarget: (id: TargetId) => Target;
} {
  const calls: TargetCalls = { deploy: [], undeploy: [] };
  const make = (id: TargetId): Target => ({
    id,
    displayName: `Fake ${id}`,
    async detect(_scope: Scope, _root: string) {
      return opts.detect?.includes(id) ?? false;
    },
    configDir: (_scope, root) => join(root, `.${id}`),
    async deploy(input) {
      calls.deploy.push({ id, input });
      if (opts.failFor?.includes(id)) throw new PalmError('E_TARGET', `${id} is broken`);
      const rel = `.${id}/${input.entity.kind}/${input.entity.name}.txt`;
      const abs = join(input.scopeRoot, rel);
      if (existsSync(abs) && !input.ownedFiles.includes(rel) && !input.force) {
        throw new PalmError(
          'E_CONFLICT',
          `${rel} exists and is not managed by palm`,
          'use --force',
        );
      }
      if (!input.dryRun) {
        await mkdir(dirname(abs), { recursive: true });
        const content =
          input.entity.def.kind === 'mcp'
            ? JSON.stringify({ ...input.entity.def.mcp, secretValues: input.secretValues ?? null })
            : await hashPath(input.absPath);
        await writeFile(abs, content);
      }
      return { files: [rel], notes: [] };
    },
    async undeploy(entry, _scope, root, dryRun) {
      calls.undeploy.push({ id, entry, dryRun });
      if (dryRun) return;
      for (const f of entry.files)
        if (f.startsWith(`.${id}/`)) await rm(join(root, f), { force: true });
    },
  });
  const targets = {
    claude: make('claude'),
    codex: make('codex'),
    copilot: make('copilot'),
    cursor: make('cursor'),
  };
  return { calls, getTarget: (id) => targets[id] };
}
