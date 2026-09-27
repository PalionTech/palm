import { join } from 'node:path';
import pc from 'picocolors';
import type { Kind, LockEntry, OriginIndex, PalmContext, PickOption, UI } from '../core/types.js';
import { matchesQuery } from '../ui/prompts.js';
import { truncate } from '../ui/output.js';
import { editBody, finishCreate, mineDir, renderFrontmatterFile, required, validateSlug, writeNewFile, type CreateOptions } from './shared.js';

export const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', 'MultiEdit'] as const;

export const MODEL_CHOICES = ['inherit', 'opus', 'sonnet', 'haiku'] as const;

export interface AgentAnswers {
  name: string;
  description: string;
  /** undefined or 'inherit' = use the main conversation's model. */
  model?: string;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  /** `name@origin` of instructions to install alongside the agent. */
  instructions: string[];
  body: string;
}

/**
 * Canonical agent file: Claude Code frontmatter (+ skills/mcpServers lists) and the system prompt.
 * `instructions` (a palm extension no harness reads) lists `name@origin` instructions that palm
 * installs as dependencies of the agent; targets never receive the key.
 */
export function renderAgentFile(a: AgentAnswers): string {
  return renderFrontmatterFile(
    {
      name: a.name,
      description: a.description.trim(),
      model: a.model && a.model !== 'inherit' ? a.model : undefined,
      tools: a.tools.length ? a.tools.join(', ') : undefined,
      skills: a.skills.length ? a.skills : undefined,
      mcpServers: a.mcpServers.length ? a.mcpServers : undefined,
      instructions: a.instructions.length ? a.instructions : undefined,
    },
    a.body,
  );
}

export function agentPromptTemplate(name: string, description: string): string {
  return `<!--
  System prompt for the "${name}" agent.
  Delegated when: ${description.replace(/-->/g, '')}

  Write it in the second person ("You are …"). Everything inside HTML comments is removed.
  Save and close the editor to continue; an empty file falls back to a text prompt.
-->

You are ${name.replace(/-/g, ' ')}, a specialist subagent.

## Responsibilities

<!-- What this agent does, and what it must not do. -->

## Process

1.

## Output

<!-- What the agent returns to the main agent: format, length, level of detail. -->
`;
}

/**
 * Options for the skills / MCP pickers: installed entries first, then every indexed entity of `kind`,
 * labelled `name @origin` and de-duplicated by name.
 */
export function buildEntityOptions(kind: Kind, installed: LockEntry[], indexes: OriginIndex[]): PickOption<string>[] {
  const seen = new Set<string>();
  const out: PickOption<string>[] = [];
  for (const e of installed) {
    if (e.kind !== kind || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ value: e.name, label: `${e.name} @${e.origin}`, hint: 'installed' });
  }
  for (const ix of indexes) {
    for (const e of ix.entities) {
      if (e.kind !== kind || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ value: e.name, label: `${e.name} @${e.origin}`, hint: truncate(e.description, 60) || undefined });
    }
  }
  return out;
}

/** Instruction options keep the origin in the value (`name@origin`) so they can be installed as-is. */
export function buildInstructionOptions(indexes: OriginIndex[]): PickOption<string>[] {
  const seen = new Set<string>();
  const out: PickOption<string>[] = [];
  for (const ix of indexes) {
    for (const e of ix.entities) {
      if (e.kind !== 'instruction') continue;
      const value = `${e.name}@${e.origin}`;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ value, label: `${e.name} @${e.origin}`, hint: truncate(e.description, 60) || undefined });
    }
  }
  return out;
}

const SEARCH = '\u0000search';
const REGISTRY = '\u0000registry';

function uniqueOptions(options: PickOption<string>[]): PickOption<string>[] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
}

/**
 * Multiselect with a leading "search…" entry that narrows the list by a query, and optionally a
 * "search the MCP registry…" entry that adds registry results. Loops until neither is picked.
 */
export async function pickManyWithSearch(
  ui: UI,
  message: string,
  all: PickOption<string>[],
  opts: { noun: string; registry?: (query: string) => Promise<PickOption<string>[]> },
): Promise<string[]> {
  let pool = [...all];
  let visible = pool;
  let selected: string[] = [];
  for (;;) {
    const special: PickOption<string>[] = [{ value: SEARCH, label: `search ${opts.noun}…`, hint: 'filter the list by a query' }];
    if (opts.registry) special.push({ value: REGISTRY, label: 'search the MCP registry…', hint: 'find servers at registry.modelcontextprotocol.io' });
    const shown = uniqueOptions([...pool.filter((o) => selected.includes(o.value)), ...visible]);
    const picked = await ui.pickMany(message, [...special, ...shown], selected);
    selected = picked.filter((v) => v !== SEARCH && v !== REGISTRY);

    if (picked.includes(REGISTRY) && opts.registry) {
      const query = await ui.text('Search the MCP registry for', { placeholder: 'github, postgres, browser…', validate: required('a query') });
      const found = await opts.registry(query.trim());
      if (found.length) {
        const chosen = await ui.pickMany(`MCP registry results for "${query.trim()}"`, found, []);
        pool = uniqueOptions([...pool, ...found]);
        selected = [...new Set([...selected, ...chosen])];
      }
      visible = pool;
      continue;
    }
    if (picked.includes(SEARCH)) {
      const query = (await ui.text(`Search ${opts.noun}`, { placeholder: 'words to match in names and descriptions' })).trim();
      visible = query ? pool.filter((o) => matchesQuery(o, query)) : pool;
      continue;
    }
    return selected;
  }
}

export interface AgentSources {
  skills: PickOption<string>[];
  mcp: PickOption<string>[];
  instructions: PickOption<string>[];
  searchRegistry?: (query: string) => Promise<PickOption<string>[]>;
  /** Produce the system prompt (editor or text prompt) from a template. */
  editBody: (template: string) => Promise<string>;
}

/** The interactive part of `palm create agent`, independent of the filesystem. */
export async function collectAgentAnswers(ui: UI, sources: AgentSources, defaults: { name?: string } = {}): Promise<AgentAnswers> {
  const name = (await ui.text('Agent name', { initial: defaults.name, placeholder: 'code-reviewer', validate: validateSlug })).trim();
  const description = (
    await ui.text('When should the main agent delegate to it?', {
      placeholder: 'Use proactively after code changes to review correctness and security',
      validate: required('a description'),
    })
  ).trim();

  let model = await ui.pick<string>('Model', [
    { value: 'inherit', label: 'inherit', hint: 'same model as the main conversation' },
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'haiku', label: 'haiku' },
    { value: '\u0000custom', label: 'custom…', hint: 'type a model id' },
  ]);
  if (model === '\u0000custom') model = (await ui.text('Model id', { placeholder: 'full model id', validate: required('a model id') })).trim();

  const tools = await ui.pickMany<string>(
    'Tools (select none to inherit all tools)',
    CLAUDE_TOOLS.map((t) => ({ value: t, label: t })),
    [],
  );

  const skills = sources.skills.length ? await pickManyWithSearch(ui, 'Skills this agent uses', sources.skills, { noun: 'skills' }) : [];
  const mcpServers =
    sources.mcp.length || sources.searchRegistry
      ? await pickManyWithSearch(ui, 'MCP servers this agent uses', sources.mcp, { noun: 'MCP servers', registry: sources.searchRegistry })
      : [];
  const instructions = sources.instructions.length ? await ui.pickMany('Instructions to install alongside (optional)', sources.instructions, []) : [];

  const body = await sources.editBody(agentPromptTemplate(name, description));
  return { name, description, model: model === 'inherit' ? undefined : model, tools, skills, mcpServers, instructions, body };
}

async function loadSources(ctx: PalmContext, scope: CreateOptions['scope']): Promise<Omit<AgentSources, 'editBody'>> {
  const spinner = ctx.ui.spinner('Loading skills, MCP servers and instructions');
  let installed: LockEntry[] = [];
  let indexes: OriginIndex[] = [];
  try {
    const { listInstalled } = await import('../engine/query.js');
    installed = await listInstalled(ctx, scope);
  } catch (e) {
    ctx.log.debug(`could not read the lockfile: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const { getAllIndexes } = await import('../core/cache.js');
    indexes = await getAllIndexes(ctx);
  } catch (e) {
    ctx.log.warn(`could not load origin indexes: ${e instanceof Error ? e.message : String(e)}`);
  }
  spinner.stop('Loaded choices');

  const searchRegistry = ctx.flags.offline
    ? undefined
    : async (query: string): Promise<PickOption<string>[]> => {
        try {
          const { searchRegistry: search } = await import('../mcp/registry.js');
          const found = await search(query, { registryUrl: ctx.config.mcpRegistryUrl, limit: 15 });
          if (!found.length) ctx.log.info(pc.dim(`no registry servers match "${query}"`));
          return found.map((c) => ({ value: c.name, label: c.name, hint: truncate([c.version && `v${c.version}`, c.description].filter(Boolean).join(' '), 60) || undefined }));
        } catch (e) {
          ctx.log.warn(`MCP registry search failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      };

  return {
    skills: buildEntityOptions('skill', installed, indexes),
    mcp: buildEntityOptions('mcp', installed, indexes),
    instructions: buildInstructionOptions(indexes),
    searchRegistry,
  };
}

export async function createAgent(ctx: PalmContext, opts: CreateOptions): Promise<void> {
  const { mine, dir } = await mineDir(ctx);
  const sources = await loadSources(ctx, opts.scope);
  const answers = await collectAgentAnswers(
    ctx.ui,
    {
      ...sources,
      editBody: (template) =>
        editBody(ctx, { template, message: 'System prompt (Enter twice or tab to submit)', placeholder: 'You are a meticulous reviewer…' }),
    },
    { name: opts.name },
  );

  const file = join(dir, 'agents', `${answers.name}.md`);
  if (!(await writeNewFile(ctx, file, renderAgentFile(answers)))) return;
  ctx.log.success(`created ${file}`);
  // Skills, MCP servers and instructions are declared in the agent file, so the install
  // resolves them as dependencies (`via: agent:<name>`, recorded in the lock entry's `deps`).
  await finishCreate(ctx, { ...opts, kind: 'agent', entityName: answers.name, mine });
}
