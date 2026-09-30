/**
 * Fakes shared by all tests: a recording logger, a scripted UI, a PalmContext over a sandbox,
 * fake harness targets (render, apply, undeploy), and fake exec and secrets collaborators for
 * EngineDeps. Areas extend this file only under their own names.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createContext } from '../../src/core/context.js';
import { PalmError } from '../../src/core/errors.js';
import { hashPath } from '../../src/core/hash.js';
import type {
  ApplyInput,
  ApplyResult,
  ConsentAnswer,
  ConsentOutcome,
  ConsentRequest,
  EngineDeps,
  Entity,
  ExecUnit,
  LockEntry,
  Logger,
  PalmContext,
  PalmFlags,
  PickOption,
  Rendered,
  RenderedFragment,
  RenderInput,
  Scope,
  SecretDecision,
  Target,
  TargetId,
  UI,
} from '../../src/core/types.js';
import { fragmentId, renderHashOf } from '../../src/domain/lock.js';
import type { Sandbox } from './sandbox.js';

// ---------------------------------------------------------------------------
// Logger, UI, context
// ---------------------------------------------------------------------------

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
  /** Every consent prompt shown, with its text. */
  consents: Array<{ text: string; canDiff: boolean }>;
}

export interface FakeUIOptions {
  interactive?: boolean;
  choose?: (options: PickOption<unknown>[]) => unknown;
  chooseMany?: (options: PickOption<unknown>[]) => unknown[];
  /** Answers for `confirm`, in order (default: `true`). */
  confirms?: boolean[];
  /** Answers for `consent`, in order (default: `no`, the prompt's default). */
  consentAnswers?: ConsentAnswer[];
}

/** Scripted UI: `pick` returns the option chosen by `choose` (default: first). */
export function fakeUI(opts: FakeUIOptions = {}): FakeUI {
  const interactive = opts.interactive ?? true;
  const picks: FakeUI['picks'] = [];
  const pickManys: FakeUI['pickManys'] = [];
  const consents: FakeUI['consents'] = [];
  const confirms = [...(opts.confirms ?? [])];
  const answers = [...(opts.consentAnswers ?? [])];
  const refuse = (): never => {
    throw new PalmError('E_NON_INTERACTIVE', 'prompt in non-interactive fake UI');
  };
  return {
    isInteractive: interactive,
    picks,
    pickManys,
    consents,
    async pick<T>(message: string, options: PickOption<T>[]): Promise<T> {
      if (!interactive) refuse();
      picks.push({ message, options: options as PickOption<unknown>[] });
      return (opts.choose ? opts.choose(options as PickOption<unknown>[]) : options[0]!.value) as T;
    },
    async pickMany<T>(message: string, options: PickOption<T>[]): Promise<T[]> {
      if (!interactive) refuse();
      pickManys.push({ message, options: options as PickOption<unknown>[] });
      const chosen = opts.chooseMany?.(options as PickOption<unknown>[]) ?? [options[0]!.value];
      return chosen as T[];
    },
    async confirm(): Promise<boolean> {
      if (!interactive) refuse();
      return confirms.shift() ?? true;
    },
    async text(): Promise<string> {
      if (!interactive) refuse();
      return '';
    },
    async secret(): Promise<string> {
      if (!interactive) refuse();
      return 'secret';
    },
    async consent(text: string, o: { canDiff: boolean }): Promise<ConsentAnswer> {
      if (!interactive) refuse();
      consents.push({ text, canDiff: o.canDiff });
      return answers.shift() ?? 'no';
    },
    spinner() {
      return { stop() {}, message() {} };
    },
  };
}

/** The flags of a plain run: nothing set, no `--allow-exec`. */
export function defaultFlags(flags: Partial<PalmFlags> = {}): PalmFlags {
  return {
    yes: false,
    dryRun: false,
    force: false,
    offline: false,
    json: false,
    allowExec: [],
    local: false,
    ...flags,
  };
}

export async function makeContext(
  sb: Sandbox,
  opts: { ui?: UI; log?: Logger; flags?: Partial<PalmFlags>; cwd?: string } = {},
): Promise<PalmContext> {
  return createContext({
    cwd: opts.cwd ?? sb.project,
    env: sb.env,
    ui: opts.ui ?? fakeUI(),
    log: opts.log ?? fakeLogger(),
    flags: defaultFlags(opts.flags),
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface TargetCalls {
  render: Array<{ id: TargetId; input: RenderInput }>;
  apply: Array<{ id: TargetId; input: ApplyInput }>;
  undeploy: Array<{ id: TargetId; entry: LockEntry; dryRun: boolean }>;
}

export interface FakeTargetOptions {
  detect?: TargetId[];
  /** Targets whose render and apply throw E_TARGET. */
  failFor?: TargetId[];
  /** Kinds a target renders nothing for (`skipped`, with a note). */
  skip?: Partial<Record<TargetId, Entity['kind'][]>>;
}

const encoder = new TextEncoder();

/** The one file a fake target writes for an entity: `.<id>/<kind>/<name>.txt`. */
function fakeFile(id: TargetId, entity: Entity): string {
  return `.${id}/${entity.kind}/${entity.name}.txt`;
}

async function fakeContent(input: RenderInput): Promise<string> {
  const { entity } = input;
  if (entity.def.kind === 'mcp')
    return JSON.stringify({ ...entity.def.mcp, secretValues: input.secretValues ?? null });
  const hash = await hashPath(input.absPath).catch(() => 'missing');
  return `${entity.kind}:${entity.name}:${hash}\n`;
}

/** MCP servers merge into `.<id>/mcp.json` (json-key); hooks add one exec line. */
function fakeFragments(id: TargetId, entity: Entity): RenderedFragment[] {
  if (entity.def.kind !== 'mcp') return [];
  const at = `/servers/${entity.name}`;
  const file = `.${id}/mcp.json`;
  return [{ file, at, id: fragmentId(entity, 0), key: entity.name, value: { name: entity.name } }];
}

async function fakeRender(
  id: TargetId,
  input: RenderInput,
  opts: FakeTargetOptions,
): Promise<Rendered> {
  const { entity } = input;
  if (opts.failFor?.includes(id)) throw new PalmError('E_TARGET', `${id} is broken`);
  if (opts.skip?.[id]?.includes(entity.kind)) {
    const notes = [`${id} has no ${entity.kind}; skipped`];
    return {
      files: [],
      fragments: [],
      exec: [],
      notes,
      skipped: true,
      hash: renderHashOf({ files: [], fragments: [] }),
    };
  }
  const files = [{ path: fakeFile(id, entity), data: encoder.encode(await fakeContent(input)) }];
  const fragments = fakeFragments(id, entity);
  const exec =
    entity.kind === 'hook'
      ? [
          {
            id: 'Stop//-',
            canonical: `run ${entity.name}`,
            command: `run ${entity.name}`,
            file: `.${id}/hooks.json`,
            event: 'Stop',
          },
        ]
      : [];
  return { files, fragments, exec, notes: [], hash: renderHashOf({ files, fragments }) };
}

async function mergeFragment(root: string, g: RenderedFragment, dryRun: boolean): Promise<void> {
  const abs = join(root, g.file);
  const doc = existsSync(abs)
    ? (JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>)
    : {};
  const servers = (doc.servers ?? {}) as Record<string, unknown>;
  if (!dryRun) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, JSON.stringify({ ...doc, servers: { ...servers, [g.key]: g.value } }));
  }
}

async function fakeApply(
  id: TargetId,
  input: ApplyInput,
  opts: FakeTargetOptions,
): Promise<ApplyResult> {
  if (opts.failFor?.includes(id)) throw new PalmError('E_TARGET', `${id} is broken`);
  const out: ApplyResult = { files: [], merged: [], adopted: [], notes: [] };
  for (const f of input.rendered.files) {
    const abs = join(input.scopeRoot, f.path);
    const same = existsSync(abs) && (await readFile(abs)).equals(Buffer.from(f.data));
    if (existsSync(abs) && !same && !input.owned.includes(f.path) && !input.force)
      throw new PalmError(
        'E_CONFLICT',
        `${f.path} exists and palm did not write it`,
        'palm install --force',
      );
    if (same && !input.owned.includes(f.path)) out.adopted.push(f.path);
    if (!input.dryRun) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.data);
    }
    out.files.push(f.path);
  }
  for (const g of input.rendered.fragments) {
    await mergeFragment(input.scopeRoot, g, input.dryRun);
    out.merged.push({ file: g.file, at: g.at, id: g.id, key: g.key });
  }
  return out;
}

async function fakeUndeploy(
  id: TargetId,
  entry: LockEntry,
  root: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  for (const path of entry.files)
    if (path.startsWith(`.${id}/`)) await rm(join(root, path), { force: true });
  for (const m of entry.merged ?? []) {
    const abs = join(root, m.file);
    if (!m.file.startsWith(`.${id}/`) || !existsSync(abs)) continue;
    const doc = JSON.parse(await readFile(abs, 'utf8')) as { servers?: Record<string, unknown> };
    delete doc.servers?.[m.key];
    await writeFile(abs, JSON.stringify(doc));
  }
}

/** One fake harness: renders `.<id>/<kind>/<name>.txt` (and an MCP fragment), applies it, undeploys it. */
export function fakeTarget(
  id: TargetId,
  opts: FakeTargetOptions = {},
  calls?: TargetCalls,
): Target {
  return {
    id,
    displayName: `Fake ${id}`,
    async detect(_scope: Scope, _root: string) {
      return opts.detect?.includes(id) ?? false;
    },
    configDir: (_scope, root) => join(root, `.${id}`),
    outputDirs: () => [`.${id}`],
    async render(input) {
      calls?.render.push({ id, input });
      return fakeRender(id, input, opts);
    },
    async apply(input) {
      calls?.apply.push({ id, input });
      return fakeApply(id, input, opts);
    },
    async undeploy(entry, _scope, root, dryRun) {
      calls?.undeploy.push({ id, entry, dryRun });
      await fakeUndeploy(id, entry, root, dryRun);
    },
  };
}

/** Fake targets for every harness, recording their calls. */
export function fakeTargets(opts: FakeTargetOptions = {}): {
  calls: TargetCalls;
  getTarget: (id: TargetId) => Target;
} {
  const calls: TargetCalls = { render: [], apply: [], undeploy: [] };
  const targets = new Map<TargetId, Target>();
  const getTarget = (id: TargetId): Target => {
    const t = targets.get(id) ?? fakeTarget(id, opts, calls);
    targets.set(id, t);
    return t;
  };
  return { calls, getTarget };
}

// ---------------------------------------------------------------------------
// Exec and secrets collaborators
// ---------------------------------------------------------------------------

export interface FakeExec extends Pick<EngineDeps, 'execUnit' | 'askConsent'> {
  requests: ConsentRequest[];
}

/**
 * `execUnit` builds a unit from the renders' exec lines (hash over the canonical commands);
 * `askConsent` allows the keys in `allow` (default: every unit) and declines the rest.
 */
export function fakeExec(opts: { allow?: string[] } = {}): FakeExec {
  const requests: ConsentRequest[] = [];
  return {
    requests,
    execUnit(entity, renders, closure, from): ExecUnit {
      const lines = Object.values(renders).flatMap((r) => r?.exec ?? []);
      const commands = [
        ...new Map(lines.map((l) => [l.id, { id: l.id, canonical: l.canonical }])).values(),
      ];
      const key = `${entity.kind}:${entity.name}@${entity.source}`;
      const hash = `sha256:${Buffer.from(JSON.stringify(commands)).toString('hex').padEnd(64, '0').slice(0, 64)}`;
      const rendered = Object.fromEntries(
        Object.entries(renders).map(([t, r]) => [
          t,
          (r?.exec ?? []).map((l) => ({ id: l.id, command: l.command, file: l.file })),
        ]),
      );
      const kind = entity.kind === 'mcp' ? 'mcp' : 'hook';
      const unit: ExecUnit = {
        kind,
        entity,
        key,
        commands,
        closure: { ...closure, bytes: 0 },
        hash,
        rendered,
      };
      return from ? { ...unit, from } : unit;
    },
    async askConsent(_ctx, req): Promise<ConsentOutcome> {
      requests.push(req);
      const keys = req.units.map((u) => u.key);
      const allowed = opts.allow ? keys.filter((k) => opts.allow?.includes(k)) : keys;
      return { allowed, declined: keys.filter((k) => !allowed.includes(k)) };
    },
  };
}

/** Secrets collaborators: nothing found, env-ref everywhere, values from `values`. */
export function fakeSecrets(
  opts: { decision?: SecretDecision; values?: Record<string, string> } = {},
): Pick<EngineDeps, 'scanSecrets' | 'decideSecret' | 'resolveSecrets'> {
  const decision = opts.decision ?? { policy: 'env-ref', action: 'env-ref', reason: 'fake' };
  return {
    scanSecrets: () => [],
    decideSecret: async () => decision,
    resolveSecrets: async () => ({ values: opts.values ?? {}, envRefs: [] }),
  };
}
