import { basename, join } from 'node:path';
import type {
  Entity,
  McpServerConfig,
  OriginSpec,
  PalmContext,
  RegistryCandidate,
  ScanOriginFn,
  ScanResult,
  TargetId,
} from '../../src/core/types.js';
import type { EngineDeps } from '../../src/engine/deps.js';
import {
  type FakeLogger,
  type FakeUI,
  fakeLogger,
  fakeTargets,
  fakeUI,
  makeContext,
  type TargetCalls,
} from '../support/fakes.js';
import { type Sandbox, sandbox, writeFiles } from '../support/sandbox.js';

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
  secrets: [
    {
      name: 'DOCS_TOKEN',
      in: 'header',
      header: 'Authorization',
      required: true,
      format: 'Bearer {value}',
    },
  ],
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
        agent: {
          name: 'reviewer',
          description: 'reviews code',
          skills: ['tdd', 'ghost'],
          mcpServers: ['docs'],
          body: 'Review.',
        },
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
    {
      kind: 'mcp',
      name: 'docs',
      path: '.mcp.json',
      origin: '',
      def: { kind: 'mcp', mcp: DOCS_MCP },
    },
  ],
  b: [
    skill('wayfinder', 'skills/wayfinder', { description: 'the B wayfinder' }),
    skill('shared', 'skills/shared', { description: 'the B shared' }),
  ],
  c: [skill('wayfinder', 'skills/wayfinder')],
  /** Reference counting: two agents and a plugin that all use skill `shared`. */
  d: [
    skill('shared', 'skills/shared'),
    {
      kind: 'agent',
      name: 'alpha',
      path: 'agents/alpha.md',
      origin: '',
      def: {
        kind: 'agent',
        agent: {
          name: 'alpha',
          description: 'alpha',
          skills: ['shared'],
          instructions: ['style@d'],
          body: 'a',
        },
      },
    },
    {
      kind: 'agent',
      name: 'beta',
      path: 'agents/beta.md',
      origin: '',
      def: {
        kind: 'agent',
        agent: { name: 'beta', description: 'beta', skills: ['shared'], body: 'b' },
      },
    },
    {
      kind: 'agent',
      name: 'picky',
      path: 'agents/picky.md',
      origin: '',
      def: {
        kind: 'agent',
        agent: {
          name: 'picky',
          description: 'uses a skill only other origins have',
          skills: ['wayfinder'],
          body: 'p',
        },
      },
    },
    {
      kind: 'instruction',
      name: 'style',
      path: 'instructions/style.md',
      origin: '',
      def: {
        kind: 'instruction',
        instruction: { name: 'style', alwaysApply: true, body: 'Be terse.' },
      },
    },
    {
      kind: 'plugin',
      name: 'bundle',
      path: 'plugins/bundle',
      origin: '',
      def: { kind: 'plugin', members: [{ kind: 'skill', name: 'shared' }] },
    },
  ],
};

const ORIGIN_FILES: Record<string, Record<string, string>> = {
  a: {
    'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder A\n',
    'skills/tdd/SKILL.md': '---\nname: tdd\n---\ntdd A\n',
    'skills/dual/SKILL.md': 'dual skill\n',
    'agents/reviewer.md':
      '---\nname: reviewer\nskills: [tdd, ghost]\nmcpServers: [docs]\n---\nReview.\n',
    'agents/dual.md': 'dual agent\n',
    'plugins/superpowers/.claude-plugin/plugin.json': '{"name":"superpowers"}\n',
    'plugins/superpowers/skills/brainstorm/SKILL.md': 'brainstorm\n',
    '.mcp.json': JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } },
    }),
  },
  b: {
    'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder B\n',
    'skills/shared/SKILL.md': 'shared B\n',
  },
  c: { 'skills/wayfinder/SKILL.md': '---\nname: wayfinder\n---\nwayfinder A\n' },
  d: {
    'skills/shared/SKILL.md': 'shared D\n',
    'agents/alpha.md': '---\nname: alpha\nskills: [shared]\ninstructions: [style@d]\n---\na\n',
    'agents/beta.md': '---\nname: beta\nskills: [shared]\n---\nb\n',
    'agents/picky.md': '---\nname: picky\nskills: [wayfinder]\n---\np\n',
    'instructions/style.md': 'Be terse.\n',
    'plugins/bundle/.claude-plugin/plugin.json': '{"name":"bundle"}\n',
  },
};

export function fakeScan(): ScanOriginFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (root: string, spec: OriginSpec): Promise<ScanResult> => {
    calls.push(spec.alias);
    const entities = (ORIGIN_ENTITIES[basename(root)] ?? []).map((e) => ({
      ...e,
      origin: spec.alias,
    }));
    return { entities, warnings: [], detected: 'convention' };
  }) as ScanOriginFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export const REGISTRY: Record<string, RegistryCandidate[]> = {
  'io.github.acme/weather': [
    {
      name: 'io.github.acme/weather',
      version: '1.2.0',
      description: 'weather server',
      config: {
        name: 'weather',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@acme/weather@1.2.0'],
      },
    },
  ],
};

export type OriginKey = 'a' | 'b' | 'c' | 'd';

export interface World {
  sb: Sandbox;
  ctx: PalmContext;
  ui: FakeUI;
  log: FakeLogger;
  origins: Record<OriginKey, string>;
  scan: ReturnType<typeof fakeScan>;
  calls: TargetCalls;
  registryCalls: string[];
  deps: Partial<EngineDeps>;
}

export async function makeWorld(
  opts: {
    ui?: FakeUI;
    flags?: Partial<PalmContext['flags']>;
    origins?: OriginKey[];
    detect?: TargetId[];
    failFor?: TargetId[];
  } = {},
): Promise<World> {
  const sb = await sandbox();
  const keys: OriginKey[] = ['a', 'b', 'c', 'd'];
  const origins = Object.fromEntries(keys.map((k) => [k, join(sb.root, 'origins', k)])) as Record<
    OriginKey,
    string
  >;
  for (const k of keys) await writeFiles(origins[k], ORIGIN_FILES[k]!);
  const ui = opts.ui ?? fakeUI();
  const log = fakeLogger();
  const ctx = await makeContext(sb, { ui, log, flags: opts.flags ?? {} });
  for (const k of opts.origins ?? ['a'])
    ctx.config.origins.push({ alias: k, type: 'local', path: origins[k] });
  const scan = fakeScan();
  const { calls, getTarget } = fakeTargets({
    detect: opts.detect ?? [],
    failFor: opts.failFor ?? [],
  });
  const registryCalls: string[] = [];
  const deps: Partial<EngineDeps> = {
    scan,
    getTarget,
    resolveRegistry: async (name) => {
      registryCalls.push(name);
      return REGISTRY[name] ?? [];
    },
    resolveSecrets: async (_ctx, cfg) => ({
      values: {},
      envRefs: (cfg.secrets ?? []).map((s) => s.name),
    }),
  };
  return { sb, ctx, ui, log, origins, scan, calls, registryCalls, deps };
}
