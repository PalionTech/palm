import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PalmError } from '../../src/core/errors.js';
import { hashPath } from '../../src/core/hash.js';
import type {
  DeployInput,
  Entity,
  LockEntry,
  McpServerConfig,
  OriginSpec,
  PalmContext,
  RegistryCandidate,
  ScanOriginFn,
  ScanResult,
  Scope,
  Target,
  TargetId,
} from '../../src/core/types.js';
import type { EngineDeps } from '../../src/engine/deps.js';
import { fakeLogger, fakeUI, makeContext, sandbox, writeFiles, type FakeLogger, type FakeUI, type Sandbox } from '../core/helpers.js';

const skill = (name: string, path: string, extra: Partial<Entity> = {}): Entity => ({
  kind: 'skill',
  name,
  path,
  origin: '',
  description: `${name} skill`,
  def: { kind: 'skill', skill: { name, description: `${name} skill` } },
  ...extra,
});

const DOCS_MCP: McpServerConfig = {
  name: 'docs',
  transport: 'http',
  url: 'https://docs.example/mcp',
  headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
  secrets: [{ name: 'DOCS_TOKEN', in: 'header', header: 'Authorization', required: true, format: 'Bearer {value}' }],
};

/** Entities per origin directory name. Paths point at real files written by `makeWorld`. */
export const ORIGIN_ENTITIES: Record<string, Entity[]> = {
  a: [
    skill('wayfinder', 'skills/wayfinder'),
    skill('tdd', 'skills/tdd'),
    skill('dual', 'skills/dual'),
    {
      kind: 'agent',
      name: 'reviewer',
      path: 'agents/reviewer.md',
      origin: '',
      description: 'reviews code',
      def: {
        kind: 'agent',
        agent: { name: 'reviewer', description: 'reviews code', skills: ['tdd', 'ghost'], mcpServers: ['docs'], body: 'Review.' },
      },
    },
    {
      kind: 'agent',
      name: 'dual',
      path: 'agents/dual.md',
      origin: '',
      def: { kind: 'agent', agent: { name: 'dual', description: 'dual agent', body: 'x' } },
    },
    {
      kind: 'plugin',
      name: 'superpowers',
      path: 'plugins/superpowers',
      origin: '',
      description: 'a bundle',
      def: {
        kind: 'plugin',
        members: [
          { kind: 'skill', name: 'brainstorm' },
          { kind: 'skill', name: 'missing-member' },
        ],
      },
    },
    skill('brainstorm', 'plugins/superpowers/skills/brainstorm', { plugin: 'superpowers' }),
    { kind: 'mcp', name: 'docs', path: '.mcp.json', origin: '', def: { kind: 'mcp', mcp: DOCS_MCP } },
  ],
  b: [skill('wayfinder', 'skills/wayfinder', { description: 'the B wayfinder' })],
  c: [skill('wayfinder', 'skills/wayfinder')],
};

const ORIGIN_FILES: Record<string, Record<string, string>> = {
  a: {
    'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder A\n',
    'skills/tdd/SKILL.md': '---\nname: tdd\n---\ntdd A\n',
    'skills/dual/SKILL.md': 'dual skill\n',
    'agents/reviewer.md': '---\nname: reviewer\nskills: [tdd, ghost]\nmcpServers: [docs]\n---\nReview.\n',
    'agents/dual.md': 'dual agent\n',
    'plugins/superpowers/.claude-plugin/plugin.json': '{"name":"superpowers"}\n',
    'plugins/superpowers/skills/brainstorm/SKILL.md': 'brainstorm\n',
    '.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }),
  },
  b: { 'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder B\n' },
  c: { 'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder A\n' },
};

export function fakeScan(): ScanOriginFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (root: string, spec: OriginSpec): Promise<ScanResult> => {
    calls.push(spec.alias);
    const entities = (ORIGIN_ENTITIES[basename(root)] ?? []).map((e) => ({ ...e, origin: spec.alias }));
    return { entities, warnings: [], detected: 'convention' };
  }) as ScanOriginFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export interface TargetCalls {
  deploy: Array<{ id: TargetId; input: DeployInput }>;
  undeploy: Array<{ id: TargetId; entry: LockEntry; dryRun: boolean }>;
}

/** Targets that write `.<id>/<kind>/<name>.txt` under the scope root. */
export function fakeTargets(opts: { detect?: TargetId[]; failFor?: TargetId[] } = {}): { calls: TargetCalls; getTarget: (id: TargetId) => Target } {
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
        throw new PalmError('E_CONFLICT', `${rel} exists and is not managed by palm`, 'use --force');
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
      for (const f of entry.files) if (f.startsWith(`.${id}/`)) await rm(join(root, f), { force: true });
    },
  });
  const targets = { claude: make('claude'), codex: make('codex'), copilot: make('copilot'), cursor: make('cursor') };
  return { calls, getTarget: (id) => targets[id] };
}

export const REGISTRY: Record<string, RegistryCandidate[]> = {
  'io.github.acme/weather': [
    {
      name: 'io.github.acme/weather',
      version: '1.2.0',
      description: 'weather server',
      config: { name: 'weather', transport: 'stdio', command: 'npx', args: ['-y', '@acme/weather@1.2.0'] },
    },
  ],
};

export interface World {
  sb: Sandbox;
  ctx: PalmContext;
  ui: FakeUI;
  log: FakeLogger;
  origins: Record<'a' | 'b' | 'c', string>;
  scan: ReturnType<typeof fakeScan>;
  calls: TargetCalls;
  registryCalls: string[];
  deps: Partial<EngineDeps>;
}

export async function makeWorld(
  opts: {
    ui?: FakeUI;
    flags?: Partial<PalmContext['flags']>;
    origins?: Array<'a' | 'b' | 'c'>;
    detect?: TargetId[];
    failFor?: TargetId[];
  } = {},
): Promise<World> {
  const sb = await sandbox();
  const origins = { a: join(sb.root, 'origins', 'a'), b: join(sb.root, 'origins', 'b'), c: join(sb.root, 'origins', 'c') };
  for (const k of ['a', 'b', 'c'] as const) await writeFiles(origins[k], ORIGIN_FILES[k]!);
  const ui = opts.ui ?? fakeUI();
  const log = fakeLogger();
  const ctx = await makeContext(sb, { ui, log, flags: opts.flags ?? {} });
  for (const k of opts.origins ?? ['a']) ctx.config.origins.push({ alias: k, type: 'local', path: origins[k] });
  const scan = fakeScan();
  const { calls, getTarget } = fakeTargets({ detect: opts.detect ?? [], failFor: opts.failFor ?? [] });
  const registryCalls: string[] = [];
  const deps: Partial<EngineDeps> = {
    scan,
    getTarget,
    resolveRegistry: async (name) => {
      registryCalls.push(name);
      return REGISTRY[name] ?? [];
    },
    resolveSecrets: async (_ctx, cfg) => ({ values: {}, envRefs: (cfg.secrets ?? []).map((s) => s.name) }),
  };
  return { sb, ctx, ui, log, origins, scan, calls, registryCalls, deps };
}

export async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}
