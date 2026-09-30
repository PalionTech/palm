/**
 * Fakes for the engine's collaborators. Importing this module first (as a side-effect import,
 * before the engine) registers the module mocks:
 *
 * - core/git: sources come from a fake remote registry (`remotes`) or, when local, from the
 *   directory itself with a tree hash; no process is spawned.
 * - core/cache: the index is the injected scanner's result (no cache files).
 * - targets/merged-state: reads the fake targets' fragment store.
 * - core/hash, core/context, core/source-input, exec/trust: the real module when it has the
 *   0.2 exports, else a minimal stand-in (removed once every area has landed).
 *
 * `fakeTargets` render deterministic files and fragments and apply them to the sandbox;
 * `fakeExec` builds units from the renders and answers consent from a script; `fakeSecrets`
 * decides secrets from a table; `fakeScan` indexes a directory by simple conventions.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import semver from 'semver';
import { vi } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import {
  type AllowExec,
  type ConsentOutcome,
  type ConsentRequest,
  type EngineDeps,
  type Entity,
  type ExecUnit,
  type Logger,
  type McpServerConfig,
  type PalmContext,
  type PickOption,
  type Rendered,
  type RenderedFile,
  type RenderInput,
  type ScanResult,
  type SecretDecision,
  type Source,
  type SourceCheckout,
  TARGET_IDS,
  type Target,
  type TargetId,
  type UI,
} from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Small helpers (independent of palm's own modules)
// ---------------------------------------------------------------------------

export function sha(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

async function walk(
  root: string,
  rel = '',
): Promise<Array<{ rel: string; abs: string; mode: number }>> {
  const dir = join(root, rel);
  const out: Array<{ rel: string; abs: string; mode: number }> = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === '.git' || name === 'node_modules') continue;
    const r = rel ? `${rel}/${name}` : name;
    const s = await stat(join(root, r));
    if (s.isDirectory()) out.push(...(await walk(root, r)));
    else out.push({ rel: r, abs: join(root, r), mode: s.mode & 0o777 });
  }
  return out;
}

export async function treeOf(root: string): Promise<string> {
  const rows: string[] = [];
  for (const f of await walk(root))
    rows.push(`${f.rel}\0${f.mode & 0o111 ? 1 : 0}\0${sha(await readFile(f.abs))}`);
  return sha(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Fake remotes (core/git)
// ---------------------------------------------------------------------------

export interface Remote {
  /** tag or branch → sha */
  refs: Record<string, string>;
  /** sha → checkout directory */
  trees: Record<string, string>;
  /** default branch */
  head?: string;
}

export const remotes = new Map<string, Remote>();
export const fetchCalls: Array<{ source: string; sha?: string; ref?: string }> = [];

function remoteOf(url: string): Remote {
  const r = remotes.get(url);
  if (!r) throw new PalmError('E_NETWORK', `fake remote ${url} is not registered`);
  return r;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function isSemverRangeFake(ref: string): boolean {
  if (SHA_RE.test(ref) || semver.valid(ref.replace(/^v/, ''))) return false;
  return semver.validRange(ref) !== null;
}

function tags(remote: Remote): string[] {
  return Object.keys(remote.refs).filter((t) => semver.valid(t.replace(/^v/, '')));
}

function latestTag(remote: Remote): string | undefined {
  return tags(remote).sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')))[0];
}

export async function resolveRefFake(url: string, ref: string | undefined) {
  const remote = remoteOf(url);
  if (!ref) {
    const tag = latestTag(remote);
    const head = remote.head ?? 'main';
    const name = tag ?? head;
    return { ref: name, resolved: name, sha: remote.refs[name] as string };
  }
  if (remote.refs[ref]) return { ref, resolved: ref, sha: remote.refs[ref] as string };
  if (remote.trees[ref]) return { ref, resolved: ref, sha: ref };
  const range = semver.validRange(ref);
  const match = range
    ? tags(remote)
        .filter((t) => semver.satisfies(t.replace(/^v/, ''), range))
        .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')))[0]
    : undefined;
  if (!match) throw new PalmError('E_SOURCE', `no tag of ${url} satisfies ${ref}`);
  return { ref, resolved: match, sha: remote.refs[match] as string };
}

async function fetchSourceFake(
  _ctx: PalmContext,
  source: Source,
  opts: { sha?: string; refresh?: boolean } = {},
): Promise<SourceCheckout> {
  fetchCalls.push({
    source: source.name,
    ...(opts.sha ? { sha: opts.sha } : {}),
    ...(source.ref ? { ref: source.ref } : {}),
  });
  if (source.type === 'local') {
    const root = source.path as string;
    if (!existsSync(root))
      throw new PalmError('E_SOURCE', `source ${source.name}: ${root} is missing`);
    return {
      source,
      sourceId: `local__${basename(root)}`,
      root,
      repoDir: root,
      tree: await treeOf(root),
    };
  }
  const url = source.url as string;
  const r = opts.sha
    ? { resolved: opts.sha, sha: opts.sha }
    : await resolveRefFake(url, source.ref);
  const dir = remoteOf(url).trees[r.sha];
  if (!dir) throw new PalmError('E_NETWORK', `fake remote ${url} has no commit ${r.sha}`);
  const ref = opts.sha
    ? Object.entries(remoteOf(url).refs).find(([, s]) => s === opts.sha)?.[0]
    : r.resolved;
  const root = source.root ? join(dir, source.root) : dir;
  return {
    source,
    sourceId: `fake__${basename(url)}`,
    root,
    repoDir: dir,
    sha: r.sha,
    ...(ref ? { ref } : {}),
  };
}

/** The core/git module the engine sees in these tests. */
export function gitModule(real: Record<string, unknown>) {
  return {
    ...real,
    fetchSource: fetchSourceFake,
    resolveRef: resolveRefFake,
    isSemverRange: isSemverRangeFake,
    listRemoteRefs: async (url: string) => {
      const r = remoteOf(url);
      return { tags: tags(r), heads: [r.head ?? 'main'], headShas: {}, tagShas: r.refs };
    },
    latestSemverTag: (list: string[]) =>
      list.sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')))[0],
    commitDate: async () => '2026-07-14',
    fileAtSha: async (checkoutDir: string, _sha: string, rel: string) =>
      readFile(join(checkoutDir, rel), 'utf8').catch(() => undefined),
  };
}

async function importOr(
  importer: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await importer();
  } catch {
    return {};
  }
}

vi.mock('../../src/core/git.js', async (orig) => gitModule(await importOr(() => orig())));

vi.mock('../../src/targets/merged-state.js', () => ({
  mergedRecordState: fakeRecordState,
  mergedRecordValue: fakeRecordValue,
}));

// ---------------------------------------------------------------------------
// Context, UI and logger
// ---------------------------------------------------------------------------

export interface FakeLogger extends Logger {
  lines: Array<{ level: string; msg: string }>;
  text(): string;
}

export function fakeLogger(): FakeLogger {
  const lines: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => void lines.push({ level, msg });
  return {
    lines,
    text: () => lines.map((l) => l.msg).join('\n'),
    info: push('info'),
    warn: push('warn'),
    debug: push('debug'),
    success: push('success'),
  };
}

export function fakeUI(opts: { interactive?: boolean; confirm?: boolean } = {}): UI {
  const interactive = opts.interactive ?? false;
  const refuse = (): never => {
    throw new PalmError('E_NON_INTERACTIVE', 'no terminal in this test');
  };
  return {
    isInteractive: interactive,
    pick: async <T>(_m: string, options: PickOption<T>[]) =>
      interactive ? (options[0] as PickOption<T>).value : refuse(),
    pickMany: async <T>(_m: string, options: PickOption<T>[]) =>
      interactive ? options.map((o) => o.value) : refuse(),
    confirm: async () => (interactive ? (opts.confirm ?? false) : refuse()),
    text: async () => (interactive ? '' : refuse()),
    secret: async () => (interactive ? 'typed-secret' : refuse()),
    consent: async () => (interactive ? 'no' : refuse()),
    spinner: () => ({ stop() {}, message() {} }),
  };
}

export interface ContextOptions {
  root: string;
  home: string;
  palmHome: string;
  project: string;
  flags?: Partial<PalmContext['flags']>;
  ui?: UI;
  env?: NodeJS.ProcessEnv;
}

export function makeContext(o: ContextOptions): PalmContext & { log: FakeLogger } {
  return {
    paths: { palmHome: o.palmHome, home: o.home, projectRoot: o.project, cwd: o.project },
    ui: o.ui ?? fakeUI(),
    log: fakeLogger(),
    env: o.env ?? { HOME: o.home, PALM_HOME: o.palmHome },
    flags: {
      yes: false,
      dryRun: false,
      force: false,
      offline: false,
      json: false,
      allowExec: [],
      local: false,
      ...o.flags,
    },
  };
}

// ---------------------------------------------------------------------------
// Fake scanner: skills/<n>/SKILL.md, agents/<n>.md, instructions/<n>.md,
// hooks/<n>/hooks.json, mcp.json ({ name: config }), plugins/<p>.json ({ members: ["skill:x"] })
// ---------------------------------------------------------------------------

const HIDDEN = '‮';

async function textIfExists(abs: string): Promise<string | undefined> {
  return readFile(abs, 'utf8').catch(() => undefined);
}

async function issuesOf(root: string, rel: string): Promise<Entity['issues']> {
  const abs = join(root, rel);
  const files = (await stat(abs)).isDirectory() ? (await walk(abs)).map((f) => f.abs) : [abs];
  for (const f of files)
    if ((await textIfExists(f))?.includes(HIDDEN))
      return [
        {
          code: 'hidden-unicode',
          severity: 'critical',
          message: `${relative(root, f)}: RIGHT-TO-LEFT OVERRIDE`,
          file: relative(root, f),
        },
      ];
  return undefined;
}

async function listDir(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

function entity(e: Omit<Entity, 'source'>, source: string, issues?: Entity['issues']): Entity {
  return { ...e, source, ...(issues ? { issues } : {}) };
}

async function scanSkills(root: string, source: string): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const n of await listDir(join(root, 'skills'))) {
    if (!existsSync(join(root, 'skills', n, 'SKILL.md'))) continue;
    const skill = { name: n, description: `${n} skill` };
    out.push(
      entity(
        {
          kind: 'skill',
          name: n,
          description: skill.description,
          path: `skills/${n}`,
          def: { kind: 'skill', skill },
        },
        source,
        await issuesOf(root, `skills/${n}`),
      ),
    );
  }
  return out;
}

async function scanFiles(root: string, source: string): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const f of await listDir(join(root, 'agents'))) {
    const name = f.replace(/\.md$/, '');
    const body = (await textIfExists(join(root, 'agents', f))) ?? '';
    const skills = /^skills: (.+)$/m.exec(body)?.[1]?.split(/,\s*/);
    const agent = { name, description: `${name} agent`, body, ...(skills ? { skills } : {}) };
    out.push(
      entity(
        { kind: 'agent', name, path: `agents/${f}`, def: { kind: 'agent', agent } },
        source,
        await issuesOf(root, `agents/${f}`),
      ),
    );
  }
  for (const f of await listDir(join(root, 'instructions'))) {
    const name = f.replace(/\.md$/, '');
    const body = (await textIfExists(join(root, 'instructions', f))) ?? '';
    const instruction = { name, alwaysApply: true, activation: 'always' as const, body };
    out.push(
      entity(
        {
          kind: 'instruction',
          name,
          path: `instructions/${f}`,
          def: { kind: 'instruction', instruction },
        },
        source,
        await issuesOf(root, `instructions/${f}`),
      ),
    );
  }
  return out;
}

async function scanHooks(root: string, source: string): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const n of await listDir(join(root, 'hooks'))) {
    const text = await textIfExists(join(root, 'hooks', n, 'hooks.json'));
    if (!text) continue;
    const hooks = {
      name: n,
      dialect: 'claude' as const,
      raw: JSON.parse(text),
      references: [],
      closure: { paths: [`hooks/${n}`] },
      promptHooks: [],
    };
    out.push(
      entity(
        { kind: 'hook', name: n, path: `hooks/${n}/hooks.json`, def: { kind: 'hook', hooks } },
        source,
        await issuesOf(root, `hooks/${n}`),
      ),
    );
  }
  return out;
}

async function scanMcp(root: string, source: string): Promise<Entity[]> {
  const text = await textIfExists(join(root, 'mcp.json'));
  if (!text) return [];
  return Object.entries(JSON.parse(text) as Record<string, Omit<McpServerConfig, 'name'>>).map(
    ([name, cfg]) =>
      entity(
        {
          kind: 'mcp',
          name,
          path: 'mcp.json',
          def: { kind: 'mcp', mcp: { name, ...cfg }, references: [], closure: { paths: [] } },
        },
        source,
      ),
  );
}

async function scanPlugins(root: string, source: string, all: Entity[]): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const f of await listDir(join(root, 'plugins'))) {
    const name = f.replace(/\.json$/, '');
    const { members } = JSON.parse((await textIfExists(join(root, 'plugins', f))) ?? '{}') as {
      members: string[];
    };
    const refs = members.map((m) => {
      const [kind, n] = m.split(':');
      return { kind: kind as Entity['kind'], name: n as string };
    });
    for (const e of all)
      if (refs.some((r) => r.kind === e.kind && r.name === e.name)) e.plugin = name;
    out.push(
      entity(
        { kind: 'plugin', name, path: `plugins/${f}`, def: { kind: 'plugin', members: refs } },
        source,
      ),
    );
  }
  return out;
}

export const scanCalls: string[] = [];

/** The fake scanner (`EngineDeps.scan`). */
export async function fakeScan(root: string, source: Source): Promise<ScanResult> {
  scanCalls.push(source.name);
  const entities = [
    ...(await scanSkills(root, source.name)),
    ...(await scanFiles(root, source.name)),
    ...(await scanHooks(root, source.name)),
    ...(await scanMcp(root, source.name)),
  ];
  const plugins = await scanPlugins(root, source.name, entities);
  return { entities: [...entities, ...plugins], warnings: [], detected: 'convention' };
}

// ---------------------------------------------------------------------------
// Fake targets: `.<id>/<kinds>/<name>…` files, hooks and servers as fragments of
// `.<id>/settings.json` / `.<id>/mcp.json` (a JSON map `at#key → value`)
// ---------------------------------------------------------------------------

function lockDir(id: TargetId, input: { scope: string }): string {
  return input.scope === 'global' ? `<${id}>` : `.${id}`;
}

function fragmentFile(id: TargetId, input: RenderInput, name: string): string {
  return `${lockDir(id, input)}/${name}`;
}

async function skillFiles(id: TargetId, input: RenderInput): Promise<RenderedFile[]> {
  const base = `${lockDir(id, input)}/skills/${input.entity.name}`;
  return Promise.all(
    (await walk(input.absPath)).map(async (f) => ({
      path: `${base}/${f.rel}`,
      data: await readFile(f.abs),
    })),
  );
}

function relocate(command: string, input: RenderInput): string {
  const root = input.scope === 'global' ? '"$HOME"' : '"$CLAUDE_PROJECT_DIR"';
  return command.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${root}/${input.assetsRoot}`);
}

async function closureFiles(input: RenderInput): Promise<RenderedFile[]> {
  const def = input.entity.def;
  if (input.inPlace || def.kind !== 'hook') return [];
  const out: RenderedFile[] = [];
  for (const p of def.hooks.closure.paths)
    for (const f of await walk(join(input.sourceRoot, p)))
      out.push({
        path: `${input.assetsRoot}/${p}/${f.rel}`,
        data: await readFile(f.abs),
        mode: f.mode,
      });
  return out;
}

type Emit = Pick<Rendered, 'files' | 'fragments' | 'exec' | 'notes'>;

async function renderHook(id: TargetId, input: RenderInput, out: Emit): Promise<void> {
  const def = input.entity.def;
  if (def.kind !== 'hook') return;
  const file = fragmentFile(id, input, 'settings.json');
  const events = (
    def.hooks.raw as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    }
  ).hooks;
  let n = 0;
  for (const [event, items] of Object.entries(events))
    for (const item of items) {
      const commands = item.hooks.map((h) => ({
        canonical: h.command,
        command: relocate(h.command, input),
      }));
      const value = {
        matcher: item.matcher ?? '',
        hooks: commands.map((c) => ({ type: 'command', command: c.command })),
      };
      const at = `/hooks/${event}`;
      out.fragments.push({
        file,
        at,
        id: `palm:hook:${input.entity.name}:${n++}`,
        key: sha(canonical(value)).slice(0, 15),
        value,
      });
      for (const c of commands)
        out.exec.push({
          id: `${event}//${item.matcher || '-'}`,
          canonical: c.canonical,
          command: c.command,
          file,
          event,
          ...(item.matcher ? { matcher: item.matcher } : {}),
        });
    }
  out.files.push(...(await closureFiles(input)));
}

function withValues(text: string, values: Record<string, string> | undefined): string {
  return values ? text.replace(/\$\{([A-Z0-9_]+)\}/g, (m, v: string) => values[v] ?? m) : text;
}

function renderMcp(id: TargetId, input: RenderInput, out: Emit): void {
  const def = input.entity.def;
  if (def.kind !== 'mcp') return;
  const { name: _n, secrets: _s, from: _o, ...cfg } = def.mcp;
  const literal = input.secretPolicy === 'literal' ? input.secretValues : undefined;
  const value = JSON.parse(withValues(JSON.stringify(cfg), literal)) as Record<string, unknown>;
  const file = fragmentFile(id, input, 'mcp.json');
  out.fragments.push({
    file,
    at: `/mcpServers/${def.mcp.name}`,
    id: `palm:mcp:${def.mcp.name}:0`,
    key: def.mcp.name,
    value,
  });
  if (def.mcp.transport === 'stdio') {
    const line = [def.mcp.command, ...(def.mcp.args ?? [])].join(' ');
    out.exec.push({ id: 'stdio', canonical: line, command: line, file });
  }
}

async function renderFor(
  id: TargetId,
  input: RenderInput,
  hash: (r: Pick<Rendered, 'files' | 'fragments'>) => string,
): Promise<Rendered> {
  const out: Emit = { files: [], fragments: [], exec: [], notes: [] };
  const { entity: e } = input;
  if (e.kind === 'skill') out.files.push(...(await skillFiles(id, input)));
  if (e.kind === 'agent' || e.kind === 'instruction')
    out.files.push({
      path: `${lockDir(id, input)}/${e.kind}s/${e.name}.md`,
      data: await readFile(input.absPath),
    });
  await renderHook(id, input, out);
  renderMcp(id, input, out);
  return { ...out, hash: hash(out) };
}

export interface TargetCalls {
  render: Array<{ id: TargetId; entity: string }>;
  apply: Array<{ id: TargetId; files: string[]; owned: string[]; force: boolean }>;
  undeploy: Array<{ id: TargetId; entry: string; files: string[] }>;
}

function absOf(root: string, lockPath: string, env: NodeJS.ProcessEnv | undefined): string {
  const m = /^<([a-z]+)>\/?(.*)$/.exec(lockPath);
  if (!m) return join(root, lockPath);
  const home = env?.HOME ?? root;
  const dirs: Record<string, string> = {
    home,
    palm: env?.PALM_HOME ?? join(home, '.palm'),
    agents: join(home, '.agents'),
  };
  return join(dirs[m[1] as string] ?? join(home, `.${m[1]}`), m[2] ?? '');
}

async function readStore(abs: string): Promise<Record<string, unknown>> {
  const text = await textIfExists(abs);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function writeStore(abs: string, store: Record<string, unknown>): Promise<void> {
  if (!Object.keys(store).length) return void (await rm(abs, { force: true }));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(store, null, 2)}\n`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function collisions(input: Parameters<Target['apply']>[0]): Promise<string[]> {
  const adopted: string[] = [];
  for (const f of input.rendered.files) {
    const abs = absOf(input.scopeRoot, f.path, input.env);
    const disk = await readFile(abs).catch(() => undefined);
    if (!disk) continue;
    if (sameBytes(disk, f.data)) adopted.push(f.path);
    else if (!input.owned.includes(f.path) && !input.force)
      throw new PalmError(
        'E_CONFLICT',
        `${f.path} exists and palm did not write it`,
        'to replace it, run',
        { retryWith: '--force' },
      );
  }
  return adopted;
}

async function writeFragments(input: Parameters<Target['apply']>[0]): Promise<void> {
  for (const g of input.rendered.fragments) {
    const abs = absOf(input.scopeRoot, g.file, input.env);
    const store = await readStore(abs);
    const slot = `${g.at}#${g.key}`;
    const owned = input.owned.includes(`${g.file}#${g.at}#${g.key}`);
    if (slot in store && canonical(store[slot]) !== canonical(g.value) && !owned && !input.force)
      throw new PalmError('E_CONFLICT', `${g.file} holds another ${g.at}`, 'to replace it, run', {
        retryWith: '--force',
      });
    store[slot] = g.value;
    await writeStore(abs, store);
  }
}

export interface FakeTargetOptions {
  detect?: TargetId[];
  failFor?: TargetId[];
  hash: (r: Pick<Rendered, 'files' | 'fragments'>) => string;
}

function fakeTarget(id: TargetId, o: FakeTargetOptions, calls: TargetCalls): Target {
  return {
    id,
    displayName: `Fake ${id}`,
    detect: async () => o.detect?.includes(id) ?? false,
    configDir: (_s, root) => join(root, `.${id}`),
    outputDirs: (scope) => [scope === 'global' ? `<${id}>` : `.${id}`],
    async render(input) {
      calls.render.push({ id, entity: input.entity.name });
      return renderFor(id, input, o.hash);
    },
    async apply(input) {
      calls.apply.push({
        id,
        files: input.rendered.files.map((f) => f.path),
        owned: input.owned,
        force: input.force,
      });
      if (o.failFor?.includes(id)) throw new PalmError('E_TARGET', `${id} is broken`);
      const adopted = await collisions(input);
      if (!input.dryRun) {
        for (const f of input.rendered.files) {
          const abs = absOf(input.scopeRoot, f.path, input.env);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, f.data);
          if (f.mode !== undefined) await chmod(abs, f.mode);
        }
        await writeFragments(input);
      }
      const merged = input.rendered.fragments.map(({ file, at, id: fid, key }) => ({
        file,
        at,
        id: fid,
        key,
      }));
      return { files: input.rendered.files.map((f) => f.path), merged, adopted, notes: [] };
    },
    async undeploy(entry, _scope, root, dryRun, env) {
      calls.undeploy.push({ id, entry: `${entry.kind}:${entry.name}`, files: entry.files });
      if (dryRun) return;
      for (const f of entry.files) {
        const abs = absOf(root, f, env);
        const own = f.startsWith(`.${id}/`) || f.startsWith(`<${id}>`) || f.includes('assets/');
        if (own) await rm(abs, { force: true });
      }
      for (const m of entry.merged ?? []) {
        if (!m.file.startsWith(`.${id}/`) && !m.file.startsWith(`<${id}>`)) continue;
        const abs = absOf(root, m.file, env);
        const store = await readStore(abs);
        delete store[`${m.at}#${m.key}`];
        await writeStore(abs, store);
      }
    },
  };
}

export function fakeTargets(o: FakeTargetOptions): {
  getTarget: (id: TargetId) => Target;
  calls: TargetCalls;
} {
  const calls: TargetCalls = { render: [], apply: [], undeploy: [] };
  const targets = Object.fromEntries(
    TARGET_IDS.map((id) => [id, fakeTarget(id, o, calls)]),
  ) as Record<TargetId, Target>;
  return { getTarget: (id) => targets[id], calls };
}

interface FakeRecord {
  type: string;
  file: string;
  path?: string[];
  key: string;
  value?: unknown;
  content?: string;
}

/** The fake store's slot of a record: `<at>#<key>`. */
function slotOf(rec: FakeRecord): string {
  const at = rec.type === 'md-block' ? `block:${rec.key}` : `/${(rec.path ?? []).join('/')}`;
  return `${at}#${rec.key}`;
}

/** targets/merged-state `mergedRecordState` over the fake store. */
export async function fakeRecordState(rec: FakeRecord): Promise<'held' | 'missing' | 'changed'> {
  const store = await readStore(rec.file);
  const slot = slotOf(rec);
  if (!(slot in store)) return 'missing';
  return canonical(store[slot]) === canonical(rec.value ?? rec.content) ? 'held' : 'changed';
}

/** targets/merged-state `mergedRecordValue` over the fake store. */
export async function fakeRecordValue(rec: FakeRecord): Promise<unknown> {
  return (await readStore(rec.file))[slotOf(rec)];
}

// ---------------------------------------------------------------------------
// Fake exec: units from the renders, consent from a script
// ---------------------------------------------------------------------------

export type ConsentScript = 'yes' | 'no' | ((req: ConsentRequest) => ConsentOutcome);

export interface FakeExec {
  execUnit: EngineDeps['execUnit'];
  askConsent: EngineDeps['askConsent'];
  requests: ConsentRequest[];
  script: { answer: ConsentScript };
}

function unitOf(
  entity: Entity,
  renders: Partial<Record<TargetId, Rendered>>,
  closure: { root: string; inPlace: boolean; files: ExecUnit['closure']['files'] },
): ExecUnit {
  const commands: ExecUnit['commands'] = [];
  const rendered: ExecUnit['rendered'] = {};
  for (const id of TARGET_IDS)
    for (const line of renders[id]?.exec ?? []) {
      if (!commands.some((c) => c.id === line.id && c.canonical === line.canonical))
        commands.push({
          id: line.id,
          canonical: line.canonical,
          ...(line.event ? { event: line.event } : {}),
        });
      rendered[id] = [
        ...(rendered[id] ?? []),
        { id: line.id, command: line.command, file: line.file },
      ];
    }
  const tree = closure.files.map((f) => [f.path, f.mode & 0o111 ? 1 : 0, f.hash]);
  const hash = sha(canonical({ commands: commands.map((c) => [c.id, c.canonical]), tree }));
  const kind = entity.kind === 'mcp' ? 'mcp' : 'hook';
  return {
    kind,
    entity: { kind: entity.kind, name: entity.name, source: entity.source },
    key: `${entity.kind}:${entity.name}@${entity.source}`,
    commands,
    closure: { ...closure, bytes: 0 },
    hash,
    rendered,
  };
}

function allowedBy(unit: ExecUnit, allow: AllowExec[] | 'all'): boolean {
  if (allow === 'all') return true;
  return allow.some(
    (a) =>
      a.key === unit.key &&
      unit.hash.replace(/^sha256:/, '').startsWith(a.hash.replace(/^sha256:/, '')),
  );
}

export function fakeExec(answer: ConsentScript = 'yes'): FakeExec {
  const requests: ConsentRequest[] = [];
  const script = { answer };
  const askConsent: EngineDeps['askConsent'] = async (ctx, req) => {
    requests.push(req);
    const pending = req.units.filter((u) => !allowedBy(u, ctx.flags.allowExec));
    const flagged = req.units.filter((u) => allowedBy(u, ctx.flags.allowExec)).map((u) => u.key);
    if (!pending.length) return { allowed: flagged, declined: [] };
    if (!ctx.ui.isInteractive)
      throw new PalmError(
        'E_UNTRUSTED_EXEC',
        `${pending.length} programs need your consent and there is no terminal`,
        'palm install --dry-run --review',
      );
    const a = script.answer;
    if (typeof a === 'function') return a(req);
    const keys = pending.map((u) => u.key);
    return a === 'yes'
      ? { allowed: [...flagged, ...keys], declined: [] }
      : { allowed: flagged, declined: keys };
  };
  return {
    execUnit: (e, renders, closure) => unitOf(e, renders, closure),
    askConsent,
    requests,
    script,
  };
}

// ---------------------------------------------------------------------------
// Fake secrets
// ---------------------------------------------------------------------------

export interface FakeSecrets {
  scanSecrets: EngineDeps['scanSecrets'];
  decideSecret: EngineDeps['decideSecret'];
  resolveSecrets: EngineDeps['resolveSecrets'];
  decisions: Array<{ destinationAbs: string; requested?: string }>;
  refuse: Set<string>;
}

function literalFindings(value: unknown, where: string): ReturnType<EngineDeps['scanSecrets']> {
  if (typeof value === 'string')
    return /(?:^|\s)(sk-|ghp_)[A-Za-z0-9]{8,}/.test(value)
      ? [{ where, shape: 'prefix', redacted: '<redacted sha256:00000000>' }]
      : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => literalFindings(v, `${where}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => literalFindings(v, `${where}.${k}`));
  return [];
}

export function fakeSecrets(): FakeSecrets {
  const decisions: FakeSecrets['decisions'] = [];
  const refuse = new Set<string>();
  return {
    decisions,
    refuse,
    scanSecrets: literalFindings,
    decideSecret: async (input): Promise<SecretDecision> => {
      decisions.push({
        destinationAbs: input.destinationAbs,
        ...(input.requested ? { requested: input.requested } : {}),
      });
      if ([...refuse].some((r) => input.destinationAbs.endsWith(r)))
        return {
          policy: 'env-ref',
          action: 'refused',
          reason: `${input.destinationAbs} is tracked by git; refusing to write a literal secret there`,
        };
      return {
        policy: input.requested ?? 'env-ref',
        action: input.requested === 'literal' ? 'literal' : 'env-ref',
        reason: 'ok',
      };
    },
    resolveSecrets: async (ctx, cfg) => {
      const names = [...JSON.stringify(cfg).matchAll(/\$\{([A-Z0-9_]+)\}/g)].map(
        (m) => m[1] as string,
      );
      const values = Object.fromEntries(
        names.filter((n) => ctx.env[n]).map((n) => [n, ctx.env[n] as string]),
      );
      return { values, envRefs: names.filter((n) => !ctx.env[n]) };
    },
  };
}
