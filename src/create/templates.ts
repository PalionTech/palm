/**
 * `palm create` as a template writer (DESIGN.md §10, PLAN.md §4.4): write a skill, agent,
 * instruction or hook into the project's in-repo source (`./agent-kit`, or `~/.palm/kit` under
 * `-g`), declare that source in palm.yaml when it is new, and install the entity. No prompts,
 * no editor; an existing file is `E_CONFLICT`.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { InstallResult, PalmContext, Scope } from '../core/types.js';
import { isSafeName } from '../lib/names.js';
import { type CliDeps, engineDepsOf, engineOf, type ScopeState, type SourceRef } from './engine.js';

export type CreatableKind = 'skill' | 'agent' | 'instruction' | 'hook';

export const CREATABLE: readonly CreatableKind[] = ['skill', 'agent', 'instruction', 'hook'];

export interface CreateOptions {
  kind: CreatableKind;
  name: string;
  /** The source directory (default `./agent-kit`; `~/.palm/kit` under `-g`). */
  dir?: string;
  description?: string;
  scope: Scope;
}

export interface TemplateFile {
  /** Path inside the source directory. */
  rel: string;
  content: string;
  mode?: number;
}

export interface CreateResult {
  /** The source directory (absolute). */
  dir: string;
  /** The main file written (absolute). */
  file: string;
  /** Every file written (absolute). */
  files: string[];
  /** The source the entity was installed from (absent after a dry run or a failed install). */
  source?: SourceRef;
  /** True when this call declared the source in palm.yaml. */
  declared: boolean;
  result: InstallResult;
  before: ScopeState;
  after: ScopeState;
}

const NEEDS_QUOTES = /[:#"'\\[\]{}]|^[\s\-?!&*|>%@`]|\s$/;

/** A YAML scalar: plain when it can be, else double-quoted. */
function yamlValue(text: string): string {
  return NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text;
}

function titleOf(name: string): string {
  const words = name.replace(/[-_.]+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function frontmatter(fields: Array<[string, string]>): string {
  return ['---', ...fields.map(([k, v]) => `${k}: ${yamlValue(v)}`), '---', ''].join('\n');
}

function skillMd(name: string, description: string): string {
  return `${frontmatter([
    ['name', name],
    ['description', description],
  ])}
# ${titleOf(name)}

Write the steps the agent follows when this skill applies.
`;
}

function agentMd(name: string, description: string): string {
  return `${frontmatter([
    ['name', name],
    ['description', description],
  ])}
You are ${titleOf(name)}. Describe the role, the steps to take and what to report back.
`;
}

function instructionMd(name: string, description: string): string {
  return `${frontmatter([['description', description]])}
# ${titleOf(name)}

Write the rules the agent follows in this project.
`;
}

/** `hooks/<name>/hooks.json` with one SessionStart command, and the script it runs (mode 755). */
function hookFiles(name: string, description: string): TemplateFile[] {
  const script = `hooks/${name}/scripts/${name}.sh`;
  const command = `bash "\${CLAUDE_PLUGIN_ROOT}/${script}"`;
  const hooks = {
    description,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
  };
  const body = `#!/usr/bin/env bash
# ${name}: runs when a Claude Code session starts. What it prints reaches the agent.
set -euo pipefail
echo "${name}: session started"
`;
  return [
    { rel: `hooks/${name}/hooks.json`, content: `${JSON.stringify(hooks, null, 2)}\n` },
    { rel: script, content: body, mode: 0o755 },
  ];
}

const DEFAULT_DESCRIPTION: Readonly<Record<CreatableKind, (name: string) => string>> = {
  skill: (n) => `Describe what ${n} does and when the agent should use it.`,
  agent: (n) => `Describe when to hand a task to ${n}.`,
  instruction: (n) => `Describe what ${n} covers.`,
  hook: (n) => `${n}: runs when a session starts.`,
};

/** The files a template writes, paths relative to the source directory. */
export function templateFor(
  kind: CreatableKind,
  name: string,
  description?: string,
): TemplateFile[] {
  const text = description?.trim() || DEFAULT_DESCRIPTION[kind](name);
  if (kind === 'skill') return [{ rel: `skills/${name}/SKILL.md`, content: skillMd(name, text) }];
  if (kind === 'agent') return [{ rel: `agents/${name}.md`, content: agentMd(name, text) }];
  if (kind === 'instruction')
    return [{ rel: `instructions/${name}.md`, content: instructionMd(name, text) }];
  return hookFiles(name, text);
}

/** The source directory: `--in` (from the cwd; `~/` is home), else the scope's default. */
export function sourceDirOf(ctx: PalmContext, opts: Pick<CreateOptions, 'dir' | 'scope'>): string {
  if (opts.dir) {
    const dir = opts.dir.startsWith('~/') ? join(ctx.paths.home, opts.dir.slice(2)) : opts.dir;
    return resolve(ctx.paths.cwd, dir);
  }
  if (opts.scope === 'global') return join(ctx.paths.palmHome, 'kit');
  return join(ctx.paths.projectRoot, 'agent-kit');
}

async function writeTemplate(dir: string, files: TemplateFile[]): Promise<void> {
  for (const f of files) {
    const abs = join(dir, f.rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, { flag: 'wx' });
    if (f.mode !== undefined) await chmod(abs, f.mode);
  }
}

/** How the source directory is typed on a command line: `./agent-kit`, else its full path. */
function sourceInput(ctx: PalmContext, dir: string): string {
  const rel = relative(ctx.paths.projectRoot, dir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `./${rel.split('\\').join('/')}` : dir;
}

function refuseExisting(ctx: PalmContext, dir: string, files: TemplateFile[], opts: CreateOptions) {
  const taken = files.find((f) => existsSync(join(dir, f.rel)));
  if (!taken) return;
  throw new PalmError(
    'E_CONFLICT',
    `${join(dir, taken.rel)} exists; palm create never overwrites a file`,
    `install the one that is there: palm install ${sourceInput(ctx, dir)} ${opts.kind}:${opts.name}`,
  );
}

const EMPTY: InstallResult = { outcomes: [], failures: [], warnings: [] };

/**
 * Write the template (E_CONFLICT when a file exists), then install the entity from its source,
 * which declares the source in palm.yaml when it is not there yet.
 */
export async function createEntity(
  ctx: PalmContext,
  opts: CreateOptions,
  deps: CliDeps = {},
): Promise<CreateResult> {
  if (!isSafeName(opts.name))
    throw new PalmError(
      'E_USAGE',
      `"${opts.name}" is not a name: use letters, digits, ".", "_" or "-"`,
      `palm create ${opts.kind} release-notes`,
    );
  const api = engineOf(deps);
  const dir = sourceDirOf(ctx, opts);
  const files = templateFor(opts.kind, opts.name, opts.description);
  refuseExisting(ctx, dir, files, opts);
  const before = await api.openScope(ctx, opts.scope, { readOnly: true });
  const known = before.sources.all().some((s) => s.matches(dir));
  const written = files.map((f) => join(dir, f.rel));
  const base = { dir, file: written[0] ?? dir, files: written, before };
  if (ctx.flags.dryRun) return { ...base, declared: !known, result: EMPTY, after: before };
  await writeTemplate(dir, files);
  const req = { source: dir, names: [{ kind: opts.kind, name: opts.name }] };
  const result = await api.installFromSource(ctx, req, { scope: opts.scope }, engineDepsOf(deps));
  const after = await api.openScope(ctx, opts.scope, { readOnly: true });
  const source = after.sources.all().find((s) => s.matches(dir));
  const declared = !known && source !== undefined;
  return { ...base, declared, result, after, ...(source ? { source } : {}) };
}
