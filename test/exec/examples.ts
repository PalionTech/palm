/**
 * The units of the DESIGN.md section 7 example (hook gh-cli from trailofbits/skills on claude
 * and cursor, stdio server team-helper from acme-kit), built through `execUnitOf` from renders
 * the way the engine builds them, plus the example text blocks read from DESIGN.md itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClosureFile, Entity, ExecUnit, Rendered, TargetId } from '../../src/core/types.js';
import { execUnitOf } from '../../src/exec/units.js';

export type SizedFile = ClosureFile & { size: number };

type Line = Rendered['exec'][number];

export function rendered(lines: Line[]): Rendered {
  return { files: [], fragments: [], exec: lines, notes: [], hash: 'sha256:render' };
}

const hex = (prefix: string): string => `sha256:${prefix}${'0'.repeat(64 - prefix.length)}`;

export const GH_ASSETS = '.palm/assets/trailofbits__skills/gh-cli';
const IDIOM: Partial<Record<TargetId, string>> = {
  claude: '"$CLAUDE_PROJECT_DIR"',
  cursor: '"$CURSOR_PROJECT_DIR"',
};
const HOOK_FILE: Partial<Record<TargetId, string>> = {
  claude: '.claude/settings.json',
  cursor: '.cursor/hooks.json',
};

export const ghCliEntity: Entity = {
  kind: 'hook',
  name: 'gh-cli',
  source: 'trailofbits/skills',
  path: 'plugins/gh-cli/hooks/hooks.json',
  plugin: 'gh-cli',
  def: {
    kind: 'hook',
    hooks: {
      name: 'gh-cli',
      dialect: 'claude',
      raw: {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/persist-session-id.sh',
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/intercept-github-curl.sh',
                },
              ],
            },
          ],
        },
      },
      pluginRootRel: 'plugins/gh-cli',
      references: [],
      closure: { paths: ['hooks'] },
      promptHooks: [],
    },
  },
};

/** The claude or cursor render of gh-cli: two commands, relocated into the asset directory. */
export function ghCliRender(target: 'claude' | 'cursor'): Rendered {
  const line = (id: string, script: string, event: string, matcher?: string): Line => ({
    id,
    canonical: `bash \${PLUGIN_ROOT}/hooks/${script}`,
    command: `bash ${IDIOM[target]}/${GH_ASSETS}/hooks/${script}`,
    file: HOOK_FILE[target] ?? '',
    event,
    ...(matcher ? { matcher } : {}),
  });
  return rendered([
    line('SessionStart//-', 'persist-session-id.sh', 'SessionStart'),
    line('PreToolUse//Bash', 'intercept-github-curl.sh', 'PreToolUse', 'Bash'),
  ]);
}

/** Eight scripts, 21 KB in all; the two the commands name come first in the prompt. */
export function ghCliScripts(): SizedFile[] {
  const lib = ['common', 'gh', 'json', 'log', 'paths', 'session'].map(
    (n, i): SizedFile => ({
      path: `hooks/lib/${n}.sh`,
      mode: 0o644,
      hash: hex(`c${i}`),
      size: i === 0 ? 3296 : 3294,
    }),
  );
  return [
    { path: 'hooks/persist-session-id.sh', mode: 0o755, hash: hex('1b9e04c2'), size: 612 },
    { path: 'hooks/intercept-github-curl.sh', mode: 0o755, hash: hex('77d0a9f1'), size: 1126 },
    ...lib,
  ];
}

export function ghCliUnit(): ExecUnit {
  return execUnitOf(
    ghCliEntity,
    { claude: ghCliRender('claude'), cursor: ghCliRender('cursor') },
    { root: GH_ASSETS, inPlace: false, files: ghCliScripts() },
    {
      sha: '82fe822a9d0c1b2e3f4a5b6c7d8e9f0a1b2c3d4e',
      ref: 'v2.1.0',
      date: '2026-07-14T09:12:00+02:00',
    },
  );
}

export const teamHelperEntity: Entity = {
  kind: 'mcp',
  name: 'team-helper',
  source: 'acme-kit',
  path: '.mcp.json',
  def: {
    kind: 'mcp',
    mcp: {
      name: 'team-helper',
      transport: 'stdio',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
    },
    references: [],
    closure: { paths: [] },
  },
};

export function teamHelperUnit(): ExecUnit {
  const line = (file: string): Line => ({
    id: 'stdio',
    canonical: 'node ${PLUGIN_ROOT}/server.js',
    command: 'node ".palm/assets/acme-kit/team-helper/server.js"',
    file,
  });
  return execUnitOf(
    teamHelperEntity,
    { claude: rendered([line('.mcp.json')]), cursor: rendered([line('.cursor/mcp.json')]) },
    { root: '.palm/assets/acme-kit/team-helper', inPlace: false, files: [] },
    { sha: '61ec1024b5a6c7d8e9f0a1b2c3d4e5f6a7b8c9d0', ref: 'v1.1.1' },
  );
}

const DESIGN = readFileSync(resolve(import.meta.dirname, '../../DESIGN.md'), 'utf8');

function section7(): string {
  const start = DESIGN.indexOf('## 7. Executable content and consent');
  return DESIGN.slice(start, DESIGN.indexOf('## 8. Secrets', start));
}

/** The fenced block after `marker` in DESIGN.md section 7, with its indentation removed. */
export function designBlock(marker: string): string {
  const lines = section7().split('\n');
  const from = lines.findIndex((l) => l.includes(marker));
  const open = lines.findIndex((l, i) => i > from && l.trim() === '```');
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
  const indent = (lines[open] ?? '').indexOf('`');
  return lines
    .slice(open + 1, close)
    .map((l) => l.slice(indent))
    .join('\n');
}
