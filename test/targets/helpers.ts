/** Target fixtures: a source with one entity of every kind, render inputs and a scope snapshot. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Entity,
  HookSet,
  LockEntry,
  Rendered,
  Scope,
  SourceReference,
  TargetId,
} from '../../src/core/types.js';
import type { RenderRequest } from '../../src/targets/render.js';
import { fakeEnv, tmpDir, write } from '../support/sandbox.js';

export {
  cleanupTmp,
  exists,
  fakeEnv,
  read,
  readJson,
  tmpDir,
  write,
} from '../support/sandbox.js';

export const SOURCE_NAME = 'acme/kit';
export const ASSET_SEGMENT = 'acme__kit';

export function mkEntity(def: Entity['def'], name = 'demo', entityPath?: string): Entity {
  return {
    kind: def.kind,
    name,
    path: entityPath ?? `${def.kind}s/${name}`,
    source: SOURCE_NAME,
    def,
  };
}

export const SKILL_MD = '---\nname: demo\ndescription: Demo skill\n---\n\nDo the demo.\n';
export const RUN_SH = '#!/bin/sh\necho demo\n';

export const CLAUDE_HOOKS = {
  description: 'format on edit',
  hooks: {
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh"', timeout: 30 },
        ],
      },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
};

/** The reference the index resolves for CLAUDE_HOOKS. */
export const FORMAT_REF: SourceReference = {
  raw: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh',
  form: 'plugin-root',
  site: 'command',
  rel: 'plugins/fmt/hooks/format.sh',
};

export const FMT_HOOKS: HookSet = {
  name: 'fmt',
  dialect: 'claude',
  raw: CLAUDE_HOOKS,
  pluginRootRel: 'plugins/fmt',
  references: [FORMAT_REF],
  closure: { paths: ['plugins/fmt/hooks'] },
  promptHooks: [],
};

export interface Fixture {
  root: string;
  skillDir: string;
  hooksFile: string;
}

/** A source with a skill (plus junk that must not be copied) and a Claude plugin with hooks. */
export async function makeSource(): Promise<Fixture> {
  const root = await tmpDir('palm-source-');
  const skillDir = path.join(root, 'skills', 'demo');
  await write(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  await write(path.join(skillDir, 'scripts', 'run.sh'), RUN_SH, 0o755);
  await write(path.join(skillDir, 'references', 'notes.md'), '# Notes\n');
  await write(path.join(skillDir, 'node_modules', 'x', 'index.js'), 'junk');
  await write(path.join(skillDir, '.git', 'HEAD'), 'ref: main');
  await write(path.join(skillDir, 'bundle.zip'), 'PK');
  const pluginDir = path.join(root, 'plugins', 'fmt');
  const hooksFile = path.join(pluginDir, 'hooks', 'hooks.json');
  await write(hooksFile, JSON.stringify(CLAUDE_HOOKS));
  await write(
    path.join(pluginDir, 'hooks', 'format.sh'),
    '#!/bin/sh\nprettier --write "$1"\n',
    0o755,
  );
  await write(path.join(pluginDir, 'hooks', 'lib', 'util.sh'), 'x=1\n');
  await write(path.join(pluginDir, 'server', 'index.js'), 'console.log(1)\n');
  await write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"fmt"}');
  await write(path.join(pluginDir, 'README.md'), '# fmt');
  return { root, skillDir, hooksFile };
}

const AGENT = {
  name: 'demo',
  description: 'Demo agent',
  model: 'sonnet',
  tools: ['Read', 'Bash', 'mcp__gh__search'],
  skills: ['demo'],
  mcpServers: ['gh'],
  body: 'Be helpful.\n',
};

/** One entity of every kind (and variant) with the path it has in the fixture. */
export function allKinds(src: Fixture): Array<{ label: string; entity: Entity; absPath: string }> {
  const at = (rel: string) => path.join(src.root, rel);
  const server = {
    name: 'local',
    transport: 'stdio' as const,
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/server/index.js', '--port', '${PORT:-8080}'],
  };
  const serverRef: SourceReference = {
    raw: '${CLAUDE_PLUGIN_ROOT}/server/index.js',
    form: 'plugin-root',
    site: 'args',
    rel: 'plugins/fmt/server/index.js',
  };
  return [
    {
      label: 'skill',
      entity: mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'Demo skill' } }),
      absPath: src.skillDir,
    },
    {
      label: 'command-as-skill',
      entity: mkEntity(
        {
          kind: 'skill',
          skill: {
            name: 'review',
            description: 'Review the diff',
            fromCommand: {
              body: 'Review $ARGUMENTS\n',
              argumentHint: '[files]',
              sourceFormat: 'claude-md',
            },
          },
        },
        'review',
        'commands/review.md',
      ),
      absPath: at('commands/review.md'),
    },
    {
      label: 'agent',
      entity: mkEntity({ kind: 'agent', agent: AGENT }),
      absPath: at('agents/demo.md'),
    },
    {
      label: 'instruction',
      entity: mkEntity({
        kind: 'instruction',
        instruction: {
          name: 'demo',
          globs: ['src/**'],
          alwaysApply: false,
          activation: 'paths',
          body: 'Strict.\n',
        },
      }),
      absPath: at('rules/demo.md'),
    },
    {
      label: 'hook',
      entity: mkEntity({ kind: 'hook', hooks: FMT_HOOKS }, 'fmt', 'plugins/fmt/hooks/hooks.json'),
      absPath: src.hooksFile,
    },
    {
      label: 'mcp stdio',
      entity: mkEntity(
        {
          kind: 'mcp',
          mcp: {
            name: 'gh',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'gh-mcp'],
            env: { GH_TOKEN: '${GH_TOKEN}' },
          },
          references: [],
          closure: { paths: [] },
        },
        'gh',
        '.mcp.json',
      ),
      absPath: at('.mcp.json'),
    },
    {
      label: 'mcp with a script',
      entity: mkEntity(
        {
          kind: 'mcp',
          mcp: server,
          references: [serverRef],
          closure: { paths: ['plugins/fmt/server'] },
        },
        'local',
        '.mcp.json',
      ),
      absPath: at('.mcp.json'),
    },
    {
      label: 'mcp http',
      entity: mkEntity(
        {
          kind: 'mcp',
          mcp: {
            name: 'docs',
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
          },
          references: [],
          closure: { paths: [] },
        },
        'docs',
        '.mcp.json',
      ),
      absPath: at('.mcp.json'),
    },
    {
      label: 'plugin',
      entity: mkEntity(
        { kind: 'plugin', members: [{ kind: 'skill', name: 'demo' }] },
        'fmt',
        'plugins/fmt',
      ),
      absPath: at('plugins/fmt'),
    },
  ];
}

/** The lock form of an entity's asset root in a scope. */
export function assetsRootOf(scope: Scope, name: string): string {
  return `${scope === 'project' ? '.palm' : '<palm>'}/assets/${ASSET_SEGMENT}/${name}`;
}

export interface RenderCase {
  entity: Entity;
  absPath: string;
  scope: Scope;
  scopeRoot: string;
  sourceRoot: string;
  targets?: TargetId[];
}

export function renderInput(c: RenderCase, over: Partial<RenderRequest> = {}): RenderRequest {
  return {
    entity: c.entity,
    absPath: c.absPath,
    sourceRoot: c.sourceRoot,
    source: { name: SOURCE_NAME, type: 'git', url: 'https://github.com/acme/kit.git' },
    scope: c.scope,
    scopeRoot: c.scopeRoot,
    assetsRoot: assetsRootOf(c.scope, c.entity.name),
    inPlace: false,
    secretPolicy: 'env-ref',
    env: fakeEnv(c.scopeRoot),
    ...(c.targets ? { targets: c.targets } : {}),
    ...over,
  };
}

/** The lock entry a successful apply records (what undeploy gets). */
export function lockEntryOf(
  entity: Entity,
  result: { files: string[]; merged: LockEntry['merged'] },
): LockEntry {
  return {
    kind: entity.kind,
    name: entity.name,
    source: SOURCE_NAME,
    path: entity.path,
    content: 'sha256:0',
    render: {},
    files: result.files,
    merged: result.merged,
  };
}

/** A render as readable data: file bytes as text, the hash left out (the domain computes it). */
export function readable(r: Rendered, root: string): unknown {
  const shown = {
    files: r.files.map((f) => ({
      path: f.path,
      ...(f.mode !== undefined ? { mode: f.mode.toString(8) } : {}),
      text: Buffer.from(f.data).toString('utf8'),
    })),
    fragments: r.fragments,
    exec: r.exec,
    notes: r.notes,
    ...(r.skipped ? { skipped: true } : {}),
  };
  return JSON.parse(JSON.stringify(shown).replaceAll(root, '<ROOT>'));
}

/** Every directory (`dir/`) and file (`mode bytes`) below `root`, sorted. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await walk(abs);
      } else {
        const mode = ((await fs.lstat(abs)).mode & 0o777).toString(8);
        out[rel] = `${mode} ${(await fs.readFile(abs)).toString('base64')}`;
      }
    }
  };
  await walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
