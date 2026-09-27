import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Entity, LockEntry, TargetId } from '../../src/core/types.js';
import type { TargetDeployInput } from '../../src/targets/base.js';

const created: string[] = [];

/** Real (symlink-resolved) temp dir, removed by cleanupTmp(). */
export async function tmpDir(prefix = 'palm-targets-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export async function cleanupTmp(): Promise<void> {
  while (created.length) await fs.rm(created.pop()!, { recursive: true, force: true });
}

/** Fake environment rooted in `home` (never the real one). */
export function fakeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PALM_HOME: path.join(home, '.palm'), ...extra };
}

export function mkEntity(def: Entity['def'], name = 'demo'): Entity {
  return { kind: def.kind, name, path: `${def.kind}s/${name}`, origin: 'test', def };
}

export function mkInput(over: Partial<TargetDeployInput> & Pick<TargetDeployInput, 'entity' | 'scopeRoot'>): TargetDeployInput {
  return {
    absPath: over.scopeRoot,
    originRoot: over.scopeRoot,
    scope: 'project',
    secretPolicy: 'env-ref',
    dryRun: false,
    force: false,
    ownedFiles: [],
    ...over,
  };
}

export function mkLock(entity: Entity, targets: TargetId[], files: string[], merged: LockEntry['merged'] = []): LockEntry {
  return {
    kind: entity.kind,
    name: entity.name,
    origin: 'test',
    path: entity.path,
    contentHash: 'sha256:0',
    installedAt: '2026-09-27T00:00:00Z',
    targets,
    files,
    merged,
  };
}

export async function write(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mode !== undefined) await fs.chmod(file, mode);
}

export async function read(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await read(file));
}

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export const SKILL_MD = '---\nname: demo\ndescription: Demo skill\n---\n\nDo the demo.\n';
export const RUN_SH = '#!/bin/sh\necho demo\n';

/** An origin with a skill (plus junk that must not be copied) and a Claude plugin with hooks. */
export async function makeOrigin(): Promise<{ root: string; skillDir: string; pluginDir: string; hooksFile: string }> {
  const root = await tmpDir('palm-origin-');
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
  await write(path.join(pluginDir, 'hooks', 'format.sh'), '#!/bin/sh\nprettier --write "$1"\n', 0o755);
  await write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"fmt"}');
  await write(path.join(pluginDir, 'skills', 's', 'SKILL.md'), SKILL_MD);
  await write(path.join(pluginDir, 'agents', 'a.md'), '---\nname: a\ndescription: a\n---\n');
  await write(path.join(pluginDir, 'commands', 'c.md'), 'c');
  return { root, skillDir, pluginDir, hooksFile };
}

export const CLAUDE_HOOKS = {
  description: 'format on edit',
  hooks: {
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh"', timeout: 30 }],
      },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
};
