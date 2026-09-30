/**
 * `palm migrate` on the 0.1 projects of the persona rerun, end to end: the built binary, real git
 * sources (local bare repositories), real targets, index, exec and secrets, no terminal. Each
 * fixture is what palm 0.1 left on disk (its palm.yaml, version 2 lock and the files it wrote,
 * next to files the person wrote), and every one ends with a passing `palm check`.
 */
import { lstat, mkdir, readdir, readFile, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hashPath } from '../../src/core/hash.js';
import { allowExecOf, type Files, git, Machine, type Run, writeFiles } from '../cli/world.js';

let m: Machine;
beforeEach(async () => {
  m = await Machine.create();
});
afterEach(async () => {
  await m.dispose();
});

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Every file and link below `root` (without .git and palm's cache) with its hash or link target. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const found = await readdir(root, { recursive: true, withFileTypes: true });
  for (const d of found) {
    const abs = join(d.parentPath, d.name);
    const rel = abs.slice(root.length + 1);
    if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) continue;
    if (rel.startsWith('.palm/cache/')) continue;
    if (d.isSymbolicLink()) out[rel] = `-> ${await readlink(abs)}`;
    else if (d.isFile()) out[rel] = await hashPath(abs);
  }
  return out;
}

async function rec(root: string, rel: string): Promise<{ path: string; hash: string }> {
  return { path: rel, hash: await hashPath(join(root, rel)) };
}

async function headOf(name: string): Promise<string> {
  return git(join(m.root, 'src', name), 'rev-parse', 'HEAD');
}

async function commitAll(dir: string): Promise<void> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'palm 0.1');
}

/** `palm migrate` without a terminal: refused, nothing changed; then the printed line migrates. */
/**
 * `palm migrate` without a terminal: refused, nothing changed; then the printed line migrates
 * (with `json`, as one JSON report on stdout).
 */
async function migrateWithConsent(
  cwd: string,
  root: string,
  flags: string[] = [],
  json = false,
): Promise<Run> {
  const before = await snapshot(root);
  const refused = await m.palm(cwd, 'migrate', ...flags);
  expect(refused.code, refused.all).toBe(1);
  expect(refused.all).toContain(
    `then:    palm migrate${flags.map((f) => ` ${f}`).join('')} --allow-exec`,
  );
  expect(await snapshot(root)).toEqual(before);
  const extra = json ? ['--json'] : [];
  const run = await m.palm(
    cwd,
    'migrate',
    ...flags,
    ...extra,
    '--allow-exec',
    allowExecOf(refused.all),
  );
  expect(run.code, run.all).toBe(0);
  return run;
}

async function readJson(file: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// kenji, lena, raj, dmitri: a project with an ad hoc server and a source's server
// ---------------------------------------------------------------------------

const SLACK = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] };

async function adhocProject(): Promise<{ p: string; url: string }> {
  const url = await m.source('kit', {
    'v1.0.0': {
      'skills/tdd/SKILL.md':
        '---\nname: tdd\ndescription: Test first.\n---\nWrite the test first.\n',
      'mcp/servers.json': json({
        mcpServers: { slack: { ...SLACK, env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } } },
      }),
    },
  });
  const sha = await headOf('kit');
  const p = await m.project('service-a', ['.claude', '.codex', '.cursor']);
  const mine = { mine: { command: 'uvx', args: ['mcp-server-fetch'] } };
  const docs = {
    url: 'https://docs.example/mcp',
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
  };
  const cursorDocs = { url: docs.url, headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}' } };
  const slack = { type: 'stdio', ...SLACK, env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } };
  const cursorSlack = { ...SLACK, env: { SLACK_BOT_TOKEN: '${env:SLACK_BOT_TOKEN}' } };
  const skill = await readFile(join(m.root, 'src', 'kit', 'skills', 'tdd', 'SKILL.md'), 'utf8');
  await writeFiles(p, {
    'palm.yaml': `targets: [claude, codex, cursor]\nskills:\n  - tdd@kit\nmcp:\n  - slack@kit\n  - name: docs\n    transport: http\n    url: ${docs.url}\n    headers:\n      Authorization: Bearer \${DOCS_TOKEN}\n`,
    '.gitignore': '.palm/\n',
    '.agents/skills/tdd/SKILL.md': skill,
    '.claude/skills/tdd/SKILL.md': skill,
    '.mcp.json': json({ mcpServers: { ...mine, slack, docs: { type: 'http', ...docs } } }),
    '.cursor/mcp.json': json({ mcpServers: { ...mine, slack: cursorSlack, docs: cursorDocs } }),
    '.codex/config.toml': `[mcp_servers.slack]\ncommand = "npx"\nargs = [ "-y", "@modelcontextprotocol/server-slack" ]\nenv_vars = [ "SLACK_BOT_TOKEN" ]\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n`,
  });
  const targets = ['claude', 'codex', 'cursor'];
  const git0 = { url, ref: 'v1.0.0', sha, transform: 2, targets };
  const entries = [
    {
      kind: 'skill',
      name: 'tdd',
      origin: 'kit',
      ...git0,
      path: 'skills/tdd',
      files: [
        await rec(p, '.agents/skills/tdd/SKILL.md'),
        await rec(p, '.claude/skills/tdd/SKILL.md'),
      ],
    },
    {
      kind: 'mcp',
      name: 'docs',
      origin: 'adhoc',
      path: 'docs',
      transform: 2,
      targets,
      files: [],
      merged: [
        { file: '.mcp.json', pointer: '/mcpServers/docs', value: { type: 'http', ...docs } },
        {
          file: '.codex/config.toml',
          pointer: '/mcp_servers/docs',
          value: { url: docs.url, bearer_token_env_var: 'DOCS_TOKEN' },
        },
        { file: '.cursor/mcp.json', pointer: '/mcpServers/docs', value: cursorDocs },
      ],
    },
    {
      kind: 'mcp',
      name: 'slack',
      origin: 'kit',
      ...git0,
      path: 'mcp/servers.json',
      files: [],
      merged: [
        { file: '.mcp.json', pointer: '/mcpServers/slack', value: slack },
        {
          file: '.codex/config.toml',
          pointer: '/mcp_servers/slack',
          value: { ...SLACK, env_vars: ['SLACK_BOT_TOKEN'] },
        },
        { file: '.cursor/mcp.json', pointer: '/mcpServers/slack', value: cursorSlack },
      ],
    },
  ];
  await writeFiles(p, { 'palm.lock.yaml': json({ version: 2, targets, entries }) });
  await writeFiles(m.palmHome, {
    'config.yaml': `origins:\n  - alias: kit\n    type: git\n    url: ${url}\n    layout: { skills: [skills/*], mcp: [mcp/servers.json] }\n`,
  });
  await commitAll(p);
  return { p, url };
}

describe('palm migrate on the persona projects', () => {
  it('K5 L1 J3 V2 D1 an ad hoc server and a source server are adopted by key; no harness file is deleted', async () => {
    const { p } = await adhocProject();
    const run = await migrateWithConsent(p, p);
    expect(run.all).toContain('keep ~/.palm/config.yaml until every project is migrated');
    for (const file of ['.mcp.json', '.cursor/mcp.json']) {
      const servers = (await readJson(join(p, file))).mcpServers ?? {};
      expect(Object.keys(servers).sort(), file).toEqual(['docs', 'mine', 'slack']);
    }
    expect(await readFile(join(p, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.docs]');
    const manifest = parse(await readFile(join(p, 'palm.yaml'), 'utf8'));
    expect(manifest.mcp.docs).toEqual({
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    const check = await m.palm(p, 'check');
    expect(check.code, check.all).toBe(0);
  });

  it('migrate ends by running the check and lists every changed file to commit (--json)', async () => {
    const { p } = await adhocProject();
    const refused = await m.palm(p, 'migrate');
    const run = await m.palm(p, 'migrate', '--json', '--allow-exec', allowExecOf(refused.all));
    expect(run.code, run.all).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.check.ok).toBe(true);
    expect(report.commit).toEqual(['.gitignore', 'palm.lock.yaml', 'palm.yaml']);
  });
});

// ---------------------------------------------------------------------------
// emanote (Sridhar): a local origin with a root, and comments in palm.yaml
// ---------------------------------------------------------------------------

const EMANOTE_YAML = `# emanote agent setup
targets: [claude, codex]
origins:
  - alias: emanote
    type: local
    path: .
    root: .apm
skills:
  # --- transitive: required by kolu ---
  - dpella@emanote  # transitive (kolu)
mcp:
  - name: emanote
    transport: http
    url: http://localhost:8079/mcp
`;

async function rootedProject(): Promise<string> {
  const p = await m.project('em', ['.claude', '.codex']);
  const skill = '---\nname: dpella\ndescription: Dpella MCP.\n---\nUse dpella.\n';
  await writeFiles(p, {
    'palm.yaml': EMANOTE_YAML,
    '.gitignore': '.palm/\n',
    '.apm/skills/dpella/SKILL.md': skill,
    '.agents/skills/dpella/SKILL.md': skill,
    '.claude/skills/dpella/SKILL.md': skill,
    '.mcp.json': json({
      mcpServers: { emanote: { type: 'http', url: 'http://localhost:8079/mcp' } },
    }),
    '.codex/config.toml': '[mcp_servers.emanote]\nurl = "http://localhost:8079/mcp"\n',
  });
  const targets = ['claude', 'codex'];
  const entries = [
    {
      kind: 'skill',
      name: 'dpella',
      origin: 'emanote',
      path: 'skills/dpella',
      transform: 2,
      targets,
      files: [
        await rec(p, '.agents/skills/dpella/SKILL.md'),
        await rec(p, '.claude/skills/dpella/SKILL.md'),
      ],
    },
    {
      kind: 'mcp',
      name: 'emanote',
      origin: 'adhoc',
      path: 'emanote',
      transform: 2,
      targets,
      files: [],
      merged: [
        {
          file: '.mcp.json',
          pointer: '/mcpServers/emanote',
          value: { type: 'http', url: 'http://localhost:8079/mcp' },
        },
        {
          file: '.codex/config.toml',
          pointer: '/mcp_servers/emanote',
          value: { url: 'http://localhost:8079/mcp' },
        },
      ],
    },
  ];
  await writeFiles(p, { 'palm.lock.yaml': json({ version: 2, targets, entries }) });
  // 0.1 left the generated files uncommitted.
  await git(p, 'add', 'palm.yaml', 'palm.lock.yaml', '.gitignore', '.apm');
  await git(p, 'commit', '-qm', 'palm 0.1');
  return p;
}

// ---------------------------------------------------------------------------
// raj, dmitri: the global scope in a dotfiles repository, written on another machine
// ---------------------------------------------------------------------------

const OLD_HOME = '/Users/old-machine';

async function dotfilesHome(): Promise<void> {
  const url = await m.source('kit', {
    'v1.0.0': {
      'skills/tdd/SKILL.md':
        '---\nname: tdd\ndescription: Test first.\n---\nWrite the test first.\n',
    },
  });
  const sha = await headOf('kit');
  const d = join(m.home, 'dotfiles');
  const skill = await readFile(join(m.root, 'src', 'kit', 'skills', 'tdd', 'SKILL.md'), 'utf8');
  const brave = { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server@2.1.3'] };
  const claudeBrave = { type: 'stdio', ...brave, env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } };
  const cursorBrave = { ...brave, env: { BRAVE_API_KEY: '${env:BRAVE_API_KEY}' } };
  await writeFiles(m.home, {
    'dotfiles/palm/palm.yaml':
      'targets: [claude, codex, cursor]\nskills:\n  - tdd@kit\nmcp:\n  - name: brave\n    command: npx\n    args: [-y, "@brave/brave-search-mcp-server@2.1.3"]\n    env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" }\n',
    'dotfiles/cursor/mcp.json': json({
      mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] }, brave: cursorBrave },
    }),
    '.claude.json': json({ numStartups: 3, mcpServers: { brave: claudeBrave } }),
    '.codex/config.toml':
      '[mcp_servers.brave]\ncommand = "npx"\nargs = [ "-y", "@brave/brave-search-mcp-server@2.1.3" ]\nenv_vars = [ "BRAVE_API_KEY" ]\n',
    '.agents/skills/tdd/SKILL.md': skill,
    '.claude/skills/tdd/SKILL.md': skill,
    '.palm/config.yaml': `origins:\n  - { alias: kit, type: git, url: '${url}', layout: { skills: [skills/*] } }\n`,
    '.palm/mine/agents/scribe.md': '---\nname: scribe\ndescription: Notes.\n---\nSummarise.\n',
    '.claude/agents/scribe.md': '---\nname: scribe\ndescription: Notes.\n---\nSummarise.\n',
  });
  await symlink('../dotfiles/palm/palm.yaml', join(m.palmHome, 'palm.yaml'));
  await symlink('../dotfiles/palm/palm.lock.yaml', join(m.palmHome, 'palm.lock.yaml'));
  await mkdir(join(m.home, '.cursor'), { recursive: true });
  await symlink('../dotfiles/cursor/mcp.json', join(m.home, '.cursor', 'mcp.json'));
  const old = (rel: string) => `${OLD_HOME}/${rel}`;
  const file = async (rel: string) => ({ path: old(rel), hash: await hashPath(join(m.home, rel)) });
  const targets = ['claude', 'codex', 'cursor'];
  const entries = [
    {
      kind: 'skill',
      name: 'tdd',
      origin: 'kit',
      url,
      ref: 'v1.0.0',
      sha,
      path: 'skills/tdd',
      transform: 2,
      targets,
      files: [await file('.agents/skills/tdd/SKILL.md'), await file('.claude/skills/tdd/SKILL.md')],
    },
    {
      kind: 'mcp',
      name: 'brave',
      origin: 'adhoc',
      path: 'brave',
      transform: 2,
      targets,
      files: [],
      merged: [
        { file: old('.claude.json'), pointer: '/mcpServers/brave', value: claudeBrave },
        {
          file: old('.codex/config.toml'),
          pointer: '/mcp_servers/brave',
          value: { ...brave, env_vars: ['BRAVE_API_KEY'] },
        },
        { file: old('.cursor/mcp.json'), pointer: '/mcpServers/brave', value: cursorBrave },
      ],
    },
    {
      kind: 'agent',
      name: 'scribe',
      origin: 'mine',
      path: 'agents/scribe.md',
      transform: 2,
      targets: ['claude'],
      files: [await file('.claude/agents/scribe.md')],
    },
  ];
  await writeFiles(d, {
    'palm/palm.lock.yaml': json({ version: 2, targets, createdDirs: [old('.claude')], entries }),
  });
  await git(d, 'init', '-q');
  await commitAll(d);
}

// ---------------------------------------------------------------------------
// elena, dmitri, ivan, keybase: a hook plugin under .palm/hooks and an in-repo root hook
// ---------------------------------------------------------------------------

const POWERS: Files = {
  '.claude-plugin/plugin.json': json({
    name: 'powers',
    version: '1.0.0',
    description: 'Powers.',
    mcpServers: {
      'team-helper': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/helper.js'] },
    },
  }),
  'hooks/hooks.json': json({
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|clear',
          hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start' }],
        },
      ],
    },
  }),
  'hooks/session-start': { text: '#!/bin/sh\necho powers\n', mode: 0o755 },
  'scripts/helper.js': 'console.log("helper")\n',
  'skills/brainstorming/SKILL.md':
    '---\nname: brainstorming\ndescription: Think first.\n---\nThink.\n',
};

/** A 0.1 hook entry as merged into a JSON hooks file, for Claude and Codex. */
function hookItem(matcher: string, command: string) {
  return { matcher, hooks: [{ type: 'command', command }] };
}

async function hookProject(): Promise<string> {
  const url = await m.source('powers', { 'v1.0.0': POWERS });
  const sha = await headOf('powers');
  const p = await m.project('ci', ['.claude', '.codex']);
  const kb = '$CLAUDE_PROJECT_DIR/.palm/hooks/keybase';
  const pw = '$CLAUDE_PROJECT_DIR/.palm/hooks/powers';
  const cxKb = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.palm/hooks/keybase';
  const cxPw = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.palm/hooks/powers';
  const pre = hookItem('Bash', `CLAUDE_PLUGIN_ROOT="${kb}" ${kb}/hooks/pre-commit-check.sh`);
  const start = hookItem('startup|clear', `CLAUDE_PLUGIN_ROOT="${pw}" ${pw}/hooks/session-start`);
  const cxPre = hookItem('Bash', `CLAUDE_PLUGIN_ROOT="${cxKb}" ${cxKb}/hooks/pre-commit-check.sh`);
  const cxStart = hookItem(
    'startup|clear',
    `CLAUDE_PLUGIN_ROOT="${cxPw}" ${cxPw}/hooks/session-start`,
  );
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };
  const helper = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/helper.js'] };
  const inRepoHooks = json({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-check.sh' }],
        },
      ],
    },
  });
  const check = { text: '#!/bin/sh\necho check\n', mode: 0o755 };
  const brainstorming = POWERS['skills/brainstorming/SKILL.md'] as string;
  await writeFiles(p, {
    'palm.yaml':
      'targets: [claude, codex]\norigins:\n  - { alias: keybase, type: local, path: skill }\n  - { alias: powers, type: git, url: URL }\nhooks:\n  - keybase@keybase\nplugins:\n  - powers@powers\n'.replace(
        'URL',
        url,
      ),
    '.gitignore': '.palm/\n',
    'skill/hooks/hooks.json': inRepoHooks,
    'skill/hooks/pre-commit-check.sh': check,
    '.palm/hooks/keybase/hooks/hooks.json': inRepoHooks,
    '.palm/hooks/keybase/hooks/pre-commit-check.sh': check,
    ...Object.fromEntries(Object.entries(POWERS).map(([k, v]) => [`.palm/hooks/powers/${k}`, v])),
    '.agents/skills/brainstorming/SKILL.md': brainstorming,
    '.claude/skills/brainstorming/SKILL.md': brainstorming,
    '.claude/settings.json': json({
      hooks: { Stop: [mine], PreToolUse: [pre], SessionStart: [start] },
    }),
    '.codex/hooks.json': json({ hooks: { PreToolUse: [cxPre], SessionStart: [cxStart] } }),
    '.mcp.json': json({ mcpServers: { 'team-helper': { type: 'stdio', ...helper } } }),
    '.codex/config.toml':
      '[mcp_servers.team-helper]\ncommand = "node"\nargs = [ "${CLAUDE_PLUGIN_ROOT}/scripts/helper.js" ]\n',
  });
  const targets = ['claude', 'codex'];
  const g = { origin: 'powers', url, ref: 'v1.0.0', sha, transform: 2, targets };
  const recs = (prefix: string, rels: string[]) =>
    Promise.all(rels.map((r) => rec(p, `${prefix}${r}`)));
  const entries = [
    {
      kind: 'hook',
      name: 'keybase',
      origin: 'keybase',
      path: 'hooks/hooks.json',
      transform: 2,
      targets,
      files: await recs('.palm/hooks/keybase/', ['hooks/hooks.json', 'hooks/pre-commit-check.sh']),
      merged: [
        { file: '.claude/settings.json', pointer: '/hooks/PreToolUse', value: pre },
        { file: '.codex/hooks.json', pointer: '/hooks/PreToolUse', value: cxPre },
      ],
    },
    {
      ...g,
      kind: 'plugin',
      name: 'powers',
      path: '.',
      files: [],
      deps: [
        { kind: 'skill', name: 'brainstorming' },
        { kind: 'hook', name: 'powers' },
        { kind: 'mcp', name: 'team-helper' },
      ],
    },
    {
      ...g,
      kind: 'skill',
      name: 'brainstorming',
      path: 'skills/brainstorming',
      via: 'plugin:powers',
      files: await recs('', [
        '.agents/skills/brainstorming/SKILL.md',
        '.claude/skills/brainstorming/SKILL.md',
      ]),
    },
    {
      ...g,
      kind: 'hook',
      name: 'powers',
      path: 'hooks/hooks.json',
      via: 'plugin:powers',
      files: await recs('.palm/hooks/powers/', Object.keys(POWERS)),
      merged: [
        { file: '.claude/settings.json', pointer: '/hooks/SessionStart', value: start },
        { file: '.codex/hooks.json', pointer: '/hooks/SessionStart', value: cxStart },
      ],
    },
    {
      ...g,
      kind: 'mcp',
      name: 'team-helper',
      path: '.claude-plugin/plugin.json',
      via: 'plugin:powers',
      files: [],
      merged: [
        {
          file: '.mcp.json',
          pointer: '/mcpServers/team-helper',
          value: { type: 'stdio', ...helper },
        },
        { file: '.codex/config.toml', pointer: '/mcp_servers/team-helper', value: helper },
      ],
    },
  ];
  await writeFiles(p, { 'palm.lock.yaml': json({ version: 2, targets, entries }) });
  await commitAll(p);
  return p;
}

// ---------------------------------------------------------------------------
// kitcn (Ziad): an in-repo origin that overlaps an output directory, without a terminal
// ---------------------------------------------------------------------------

async function overlapProject(): Promise<string> {
  const p = await m.project('kitcn', ['.claude', '.codex']);
  const skill = '---\nname: vision\ndescription: See it.\n---\nLook.\n';
  await writeFiles(p, {
    'palm.yaml':
      'targets: [claude, codex]\norigins:\n  - { alias: kitcn-rules, type: local, path: .agents }\nskills:\n  - vision@kitcn-rules\n',
    '.gitignore': '.palm/\n',
    '.agents/rules/vision/SKILL.md': skill,
    '.claude/skills/vision/SKILL.md': skill,
  });
  const entries = [
    {
      kind: 'skill',
      name: 'vision',
      origin: 'kitcn-rules',
      path: 'rules/vision',
      transform: 2,
      targets: ['claude'],
      files: [await rec(p, '.claude/skills/vision/SKILL.md')],
    },
  ];
  await writeFiles(p, {
    'palm.lock.yaml': json({ version: 2, targets: ['claude', 'codex'], entries }),
  });
  await commitAll(p);
  return p;
}

describe('palm migrate on the persona projects, continued', () => {
  it('R2 R3 K19 a local origin with a root becomes ./.apm, comments stay, untracked outputs are listed to commit', async () => {
    const p = await rootedProject();
    const run = await m.palm(p, 'migrate', '--json');
    expect(run.code, run.all).toBe(0);
    const text = await readFile(join(p, 'palm.yaml'), 'utf8');
    expect(Object.keys(parse(text).sources)).toEqual(['./.apm']);
    expect(text).toContain('# emanote agent setup\ntargets: [claude, codex]\n');
    expect(text).toContain(
      '  # --- transitive: required by kolu ---\n  # transitive (kolu)\n  ./.apm:\n',
    );
    const report = JSON.parse(run.stdout);
    expect(report.commit).toEqual([
      '.agents/',
      '.claude/',
      '.codex/',
      '.gitignore',
      '.mcp.json',
      'palm.lock.yaml',
      'palm.yaml',
    ]);
    expect((await readJson(join(p, '.mcp.json'))).mcpServers?.emanote).toBeDefined();
    const check = await m.palm(p, 'check');
    expect(check.code, check.all).toBe(0);
    expect(check.all).not.toContain('changed since palm.lock.yaml');
  });

  it('J2 D16 J17 migrate -g writes through the dotfiles links, keeps every server, maps another home onto this one', async () => {
    await dotfilesHome();
    const run = await migrateWithConsent(m.home, m.home, ['-g'], true);
    expect(JSON.parse(run.stdout).commit).toEqual([
      '~/dotfiles/palm/palm.lock.yaml',
      '~/dotfiles/palm/palm.yaml',
    ]);
    expect(run.all).toContain(
      'copy ~/.palm/mine/agents/scribe.md to ~/.palm/kit/agents/scribe.md, then run: palm install ~/.palm/kit scribe -g',
    );
    expect(run.all).toContain(
      '~/.palm/config.yaml is no longer read; delete it once every project is migrated',
    );
    for (const link of ['.palm/palm.yaml', '.palm/palm.lock.yaml', '.cursor/mcp.json'])
      expect((await lstat(join(m.home, link))).isSymbolicLink(), link).toBe(true);
    const cursor = await readJson(join(m.home, 'dotfiles/cursor/mcp.json'));
    expect(Object.keys(cursor.mcpServers ?? {}).sort()).toEqual(['brave', 'fetch']);
    const claude = await readJson(join(m.home, '.claude.json'));
    expect(claude.numStartups).toBe(3);
    expect(Object.keys(claude.mcpServers ?? {})).toEqual(['brave']);
    const lock = await readFile(join(m.home, 'dotfiles/palm/palm.lock.yaml'), 'utf8');
    expect(lock).toContain('version: 3');
    expect(lock).not.toContain(OLD_HOME);
    expect(lock).toContain('<claude>/skills/tdd/SKILL.md');
    const check = await m.palm(m.home, 'check', '-g');
    expect(check.code, check.all).toBe(0);
  });

  it('C7 C17 E3 V2 a hook plugin and an in-repo root hook migrate under one consent; .palm/hooks goes', async () => {
    const p = await hookProject();
    const run = await migrateWithConsent(p, p);
    expect(run.all).toContain('hook keybase from ./skill is hook skill in palm 0.2');
    expect(run.all).toContain('hook skill runs in place from ./skill; removed .palm/hooks/keybase');
    expect(run.all).toContain('moved .palm/hooks/powers → .palm/assets/powers/powers');
    expect(await snapshot(join(p, '.palm'))).toEqual({
      'assets/powers/powers/hooks/hooks.json': expect.any(String),
      'assets/powers/powers/hooks/session-start': expect.any(String),
      'assets/powers/team-helper/scripts/helper.js': expect.any(String),
    });
    expect(parse(await readFile(join(p, 'palm.yaml'), 'utf8')).sources['./skill'].hooks).toEqual([
      'skill',
    ]);
    const settings = await readFile(join(p, '.claude/settings.json'), 'utf8');
    expect(settings).toContain('echo mine');
    expect(settings).toContain('/skill/hooks/pre-commit-check.sh');
    expect(settings).toContain('/.palm/assets/powers/powers/hooks/session-start');
    expect(settings).not.toContain('.palm/hooks/');
    const helper = (await readJson(join(p, '.mcp.json'))).mcpServers?.['team-helper'] as {
      args: string[];
    };
    expect(helper.args).toEqual(['.palm/assets/powers/team-helper/scripts/helper.js']);
    const check = await m.palm(p, 'check');
    expect(check.code, check.all).toBe(0);
  });

  it('Z3 without a terminal an overlapping source refuses before any write; after the move the migration passes check', async () => {
    const p = await overlapProject();
    const before = await snapshot(p);
    const refused = await m.palm(p, 'migrate');
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all).toContain('overlaps the codex output directory .agents/skills/');
    expect(await snapshot(p)).toEqual(before);
    const dry = await m.palm(p, 'migrate', '--dry-run');
    expect(dry.code).toBe(1);
    expect(dry.all).toContain('./.agents:');
    expect(await snapshot(p)).toEqual(before);
    await git(p, 'mv', '.agents/rules', 'agent-rules');
    const yaml = (await readFile(join(p, 'palm.yaml'), 'utf8')).replace(
      'path: .agents',
      'path: agent-rules',
    );
    const lock = (await readFile(join(p, 'palm.lock.yaml'), 'utf8')).replace(
      '"rules/vision"',
      '"vision"',
    );
    await writeFiles(p, { 'palm.yaml': yaml, 'palm.lock.yaml': lock });
    const run = await m.palm(p, 'migrate');
    expect(run.code, run.all).toBe(0);
    const check = await m.palm(p, 'check');
    expect(check.code, check.all).toBe(0);
  });
});
