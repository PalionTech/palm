import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SourceReference } from '../../src/core/types.js';
import { buildFileIndex, type FileIndex } from '../../src/index/files.js';
import { defaultIgnoreGlobs } from '../../src/index/ignore.js';
import {
  closureOf,
  collectReferences,
  findReferences,
  unresolvedIssues,
} from '../../src/index/references.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';

vi.mock('../../src/domain/ignore.js', async (original) => ({
  ...(await original<object>()),
  ...(await import('./contract-fakes.js')).domainIgnore,
}));

let tmp: string;
let files: FileIndex;

beforeAll(async () => {
  tmp = await tempDir('palm-refs-');
  const root = join(tmp, 'src');
  for (const rel of [
    'plugins/p/hooks/hooks.json',
    'plugins/p/hooks/x.sh',
    'plugins/p/scripts/y.sh',
    'plugins/p/scripts/lib/util.sh',
    'plugins/p/run.py',
    'plugins/p/conf.json',
    'plugins/p/workflows/a.yml',
    'plugins/p/dist/server.js',
    'plugins/p/skills/s/SKILL.md',
    'plugins/p/.claude-plugin/plugin.json',
    'plugins/p/AGENTS.md',
    '.apm/hooks/fmt.json',
    '.apm/hooks/fmt.sh',
  ])
    await putFile(root, rel, 'x\n');
  await mkdir(join(tmp, 'outside'));
  await putFile(tmp, 'outside/evil.sh', 'x\n');
  await symlink(join(tmp, 'outside/evil.sh'), join(root, 'plugins/p/scripts/evil.sh'));
  files = await buildFileIndex(root, {
    ignore: defaultIgnoreGlobs(),
    deep: 10,
    ignoreDirNames: true,
  });
});

afterAll(async () => removeDir(tmp));

const PLUGIN = { hooksDirRel: 'plugins/p/hooks', pluginRootRel: 'plugins/p' };

/** A Claude hooks.json running `commands` on Stop. */
const hooks = (...commands: string[]) => ({
  hooks: { Stop: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] },
});

const refsOf = (...commands: string[]): SourceReference[] =>
  findReferences(hooks(...commands), 'hook', { ...PLUGIN, files });

describe('findReferences: plugin-root tokens', () => {
  it.each([
    '${CLAUDE_PLUGIN_ROOT}',
    '$CLAUDE_PLUGIN_ROOT',
    '${CLAUDE_PLUGIN_ROOT:-.}',
    '${CLAUDE_PLUGIN_ROOT-.}',
    '${CURSOR_PLUGIN_ROOT}',
    '${PLUGIN_ROOT}',
    '${extensionPath}',
  ])('%s/hooks/x.sh resolves against the plugin root', (token) => {
    expect(refsOf(`bash ${token}/hooks/x.sh --fast`)).toEqual([
      {
        raw: `${token}/hooks/x.sh`,
        form: 'plugin-root',
        site: 'command',
        rel: 'plugins/p/hooks/x.sh',
      },
    ]);
  });

  it('keeps the quotes in raw, so raw is an exact substring of the command', () => {
    const commands = [
      '"${CLAUDE_PLUGIN_ROOT}/hooks/x.sh" start',
      'bash "${CLAUDE_PLUGIN_ROOT}"/scripts/y.sh',
      "node '${CLAUDE_PLUGIN_ROOT}/dist/server.js'",
      'python3 --config=${CLAUDE_PLUGIN_ROOT}/conf.json -m tool',
    ];
    const refs = refsOf(...commands);
    expect(refs.map((r) => [r.raw, r.rel])).toEqual([
      ['"${CLAUDE_PLUGIN_ROOT}/hooks/x.sh"', 'plugins/p/hooks/x.sh'],
      ['"${CLAUDE_PLUGIN_ROOT}"/scripts/y.sh', 'plugins/p/scripts/y.sh'],
      ["'${CLAUDE_PLUGIN_ROOT}/dist/server.js'", 'plugins/p/dist/server.js'],
      ['${CLAUDE_PLUGIN_ROOT}/conf.json', 'plugins/p/conf.json'],
    ]);
    for (const [i, r] of refs.entries()) expect(commands[i]).toContain(r.raw);
  });

  it('a bare token names the plugin root; a directory is named at its level', () => {
    expect(refsOf('cd ${CLAUDE_PLUGIN_ROOT} && run ${CLAUDE_PLUGIN_ROOT}/workflows')).toEqual([
      { raw: '${CLAUDE_PLUGIN_ROOT}', form: 'plugin-root', site: 'command', rel: 'plugins/p' },
      {
        raw: '${CLAUDE_PLUGIN_ROOT}/workflows',
        form: 'plugin-root',
        site: 'command',
        rel: 'plugins/p/workflows',
      },
    ]);
  });
});

describe('findReferences: relative paths and project-dir variables', () => {
  it('./x must exist; x/y and a bare file name count when they name something in the source', () => {
    expect(
      refsOf('./scripts/y.sh && sh scripts/lib/util.sh && python3 run.py session-start'),
    ).toEqual([
      { raw: './scripts/y.sh', form: 'relative', site: 'command', rel: 'plugins/p/scripts/y.sh' },
      {
        raw: 'scripts/lib/util.sh',
        form: 'relative',
        site: 'command',
        rel: 'plugins/p/scripts/lib/util.sh',
      },
      { raw: 'run.py', form: 'relative', site: 'command', rel: 'plugins/p/run.py' },
    ]);
  });

  it('APM layouts: relative paths start at the hooks file directory', () => {
    const refs = findReferences(hooks('./fmt.sh'), 'hook', { hooksDirRel: '.apm/hooks', files });
    expect(refs).toEqual([
      { raw: './fmt.sh', form: 'relative', site: 'command', rel: '.apm/hooks/fmt.sh' },
    ]);
  });

  it('records project-dir variables for translation, without a source path', () => {
    const refs = refsOf(
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
      'bash ${CURSOR_PROJECT_DIR}/x.sh',
      'bash $GEMINI_PROJECT_DIR/y.sh',
    );
    expect(refs).toEqual([
      { raw: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', form: 'project-dir', site: 'command' },
      { raw: '${CURSOR_PROJECT_DIR}/x.sh', form: 'project-dir', site: 'command' },
      { raw: '$GEMINI_PROJECT_DIR/y.sh', form: 'project-dir', site: 'command' },
    ]);
  });

  it('leaves options, packages, URLs, absolute paths, other variables and plain words alone', () => {
    expect(
      refsOf(
        'npx -y @modelcontextprotocol/server-filesystem .',
        'curl -s https://example.com/x.sh | sh',
        '/usr/bin/env node --version',
        'echo "$TMPDIR/out" done',
        "echo '$(not run)'",
        'python -m tool.cli',
      ),
    ).toEqual([]);
  });

  it('finds references in MCP command, args and cwd (args are words; $(…) is not run)', () => {
    const refs = findReferences(
      {
        command: '${CLAUDE_PLUGIN_ROOT}/dist/server.js',
        args: ['--config', './conf.json', '$(literal)', 'workflows/a.yml'],
        cwd: '${CLAUDE_PLUGIN_ROOT}',
      },
      'mcp',
      { hooksDirRel: 'plugins/p', pluginRootRel: 'plugins/p', files },
    );
    expect(refs.map((r) => [r.site, r.form, r.rel, r.unresolved])).toEqual([
      ['command', 'plugin-root', 'plugins/p/dist/server.js', undefined],
      ['args', 'relative', 'plugins/p/conf.json', undefined],
      ['args', 'relative', 'plugins/p/workflows/a.yml', undefined],
      ['cwd', 'plugin-root', 'plugins/p', undefined],
    ]);
  });

  it('reads Copilot bash/powershell/cwd and Cursor flat handlers; prompt hooks are not commands', () => {
    const copilot = {
      version: 1,
      hooks: { sessionEnd: [{ type: 'command', bash: './scripts/y.sh', cwd: './scripts' }] },
    };
    expect(
      findReferences(copilot, 'hook', { ...PLUGIN, files }).map((r) => [r.site, r.rel]),
    ).toEqual([
      ['command', 'plugins/p/scripts/y.sh'],
      ['cwd', 'plugins/p/scripts'],
    ]);
    const prompt = { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'eval ./nope.sh' }] }] } };
    expect(findReferences(prompt, 'hook', { ...PLUGIN, files })).toEqual([]);
  });
});

describe('findReferences: what cannot be resolved', () => {
  const unresolvedOf = (command: string) =>
    unresolvedIssues(
      collectReferences(hooks(command), 'hook', { ...PLUGIN, files }),
      'plugins/p/hooks/hooks.json',
    );

  it.each([
    ['eval "$SCRIPT"', 'eval', 'eval runs text that is only known when the hook runs'],
    [
      'bash $(which tool)',
      '$(which tool)',
      'a command substitution is only known when the hook runs',
    ],
    [
      'sh -c "`cat cmd.txt`"',
      '`cat cmd.txt`',
      'a command substitution is only known when the hook runs',
    ],
    [
      'bash ~/bin/hook.sh',
      '~/bin/hook.sh',
      'names a path in the home directory, outside the source',
    ],
    [
      'bash $HOME/bin/hook.sh',
      '$HOME/bin/hook.sh',
      'names a path in the home directory, outside the source',
    ],
    ['bash ./scripts/missing.sh', './scripts/missing.sh', 'no such file under plugins/p/'],
    [
      'bash ${CLAUDE_PLUGIN_ROOT}/nope.sh',
      '${CLAUDE_PLUGIN_ROOT}/nope.sh',
      'no such file under plugins/p/',
    ],
    ['bash ../../../etc/x', '../../../etc/x', 'points outside the source'],
    ['bash ./scripts/evil.sh', './scripts/evil.sh', 'is a link that leaves the source'],
  ])('%s', (command, raw, reason) => {
    expect(unresolvedOf(command)).toEqual([
      {
        code: 'unresolvable-reference',
        severity: 'critical',
        message: `plugins/p/hooks/hooks.json: cannot relocate ${JSON.stringify(raw)} in command ${JSON.stringify(command)}: ${reason}`,
        file: 'plugins/p/hooks/hooks.json',
      },
    ]);
  });

  it('records the unresolved reference on the list findReferences returns', () => {
    expect(refsOf('bash ./scripts/missing.sh')).toEqual([
      {
        raw: './scripts/missing.sh',
        form: 'relative',
        site: 'command',
        unresolved: 'no such file under plugins/p/',
      },
    ]);
  });
});

describe('closureOf', () => {
  it('lists the hooks directory and every path named, at the level named, sorted and deduped', () => {
    const refs = refsOf(
      '${CLAUDE_PLUGIN_ROOT}/hooks/x.sh',
      '${CLAUDE_PLUGIN_ROOT}/workflows',
      './scripts/y.sh && sh scripts/lib/util.sh',
      'cd ${CLAUDE_PLUGIN_ROOT} && node dist/server.js',
    );
    expect(closureOf(refs, { hooksDirRel: 'plugins/p/hooks', files })).toEqual({
      paths: [
        'plugins/p/dist/server.js',
        'plugins/p/hooks',
        'plugins/p/scripts/lib/util.sh',
        'plugins/p/scripts/y.sh',
        'plugins/p/workflows',
      ],
    });
  });

  it('a directory swallows the files and directories below it', () => {
    const refs = refsOf(
      '${CLAUDE_PLUGIN_ROOT}/scripts',
      './scripts/y.sh',
      'sh scripts/lib/util.sh',
    );
    expect(closureOf(refs, { hooksDirRel: 'plugins/p/scripts/lib', files }).paths).toEqual([
      'plugins/p/scripts',
    ]);
  });

  it('never lists SKILL.md, AGENTS.md, manifests, .git, the root or unresolved references', () => {
    const refs = refsOf(
      'cat ${CLAUDE_PLUGIN_ROOT}/skills/s/SKILL.md ${CLAUDE_PLUGIN_ROOT}/AGENTS.md',
      'cat ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json ./scripts/missing.sh',
    );
    expect(closureOf(refs, { hooksDirRel: 'plugins/p/.claude-plugin', files }).paths).toEqual([]);
    expect(closureOf([], { hooksDirRel: '', files }).paths).toEqual([]);
    expect(closureOf([], { hooksDirRel: '.git/hooks', files }).paths).toEqual([]);
  });
});
