/** Target-specific fixtures; the generic fs helpers live in test/support/sandbox.ts. */
import path from 'node:path';
import type { DeployInput, Entity, LockEntry, TargetId } from '../../src/core/types.js';
import { tmpDir, write } from '../support/sandbox.js';

export {
  cleanupTmp,
  exists,
  fakeEnv,
  read,
  readJson,
  tmpDir,
  write,
} from '../support/sandbox.js';

export function mkEntity(def: Entity['def'], name = 'demo'): Entity {
  return { kind: def.kind, name, path: `${def.kind}s/${name}`, origin: 'test', def };
}

export function mkInput(
  over: Partial<DeployInput> & Pick<DeployInput, 'entity' | 'scopeRoot'>,
): DeployInput {
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

export function mkLock(
  entity: Entity,
  targets: TargetId[],
  files: string[],
  merged: LockEntry['merged'] = [],
): LockEntry {
  return {
    kind: entity.kind,
    name: entity.name,
    origin: 'test',
    path: entity.path,
    contentHash: 'sha256:0',
    transform: 1,
    targets,
    files: files.map((path) => ({ path, hash: '' })),
    merged,
  };
}

export const SKILL_MD = '---\nname: demo\ndescription: Demo skill\n---\n\nDo the demo.\n';
export const RUN_SH = '#!/bin/sh\necho demo\n';

/** An origin with a skill (plus junk that must not be copied) and a Claude plugin with hooks. */
export async function makeOrigin(): Promise<{
  root: string;
  skillDir: string;
  pluginDir: string;
  hooksFile: string;
}> {
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
  await write(
    path.join(pluginDir, 'hooks', 'format.sh'),
    '#!/bin/sh\nprettier --write "$1"\n',
    0o755,
  );
  await write(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"fmt"}');
  await write(path.join(pluginDir, 'skills', 's', 'SKILL.md'), SKILL_MD);
  await write(path.join(pluginDir, 'agents', 'a.md'), '---\nname: a\ndescription: a\n---\n');
  await write(path.join(pluginDir, 'commands', 'c.md'), 'c');
  await write(path.join(pluginDir, 'docs', 'guide.md'), '# guide');
  await write(path.join(pluginDir, 'tests', 'hook.test.sh'), 'exit 0');
  await write(path.join(pluginDir, 'README.md'), '# fmt');
  return { root, skillDir, pluginDir, hooksFile };
}

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
