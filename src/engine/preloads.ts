/**
 * Agent preloads (K3). An agent's `skills:` and `mcpServers:` name what the harness loads with
 * it; palm installs only what the person names (PLAN §6), so it says when a preload is not
 * installed: when the agent arrives (install), when a new version preloads more (update), when
 * a preloaded skill leaves (remove), and `check` lists every gap (`missingPreloads`). One line:
 *
 *   agent reviewer preloads skill incident, not installed: palm install acme incident
 */
import type { Entity, Kind, LockEntry, SourceIndex } from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import type { Run } from './jobs.js';
import { palmCommand } from './report.js';
import { resolveSource } from './resolve.js';
import { lockedSource } from './scope.js';
import { sourceRefOf } from './sources.js';

/** One agent's preloads that no entry of the scope provides. */
export interface PreloadGap {
  agent: { name: string; source: string };
  /** `skill incident`, `mcp slack`. */
  missing: Array<{ kind: 'skill' | 'mcp'; name: string }>;
  /** `palm install <agent's source> <names>` for the missing ones that source offers. */
  command?: string;
  /** Missing names the agent's source does not offer (no command installs them from there). */
  elsewhere?: string[];
}

/** What an agent entity preloads. */
export function preloadsOf(agent: Entity): Array<{ kind: 'skill' | 'mcp'; name: string }> {
  if (agent.def.kind !== 'agent') return [];
  const skills = (agent.def.agent.skills ?? []).map((name) => ({ kind: 'skill' as const, name }));
  const servers = (agent.def.agent.mcpServers ?? []).map((name) => ({
    kind: 'mcp' as const,
    name,
  }));
  return [...skills, ...servers];
}

/** Names installed in the scope per kind (declined programs are not installed). */
export function installedNames(
  entries: readonly LockEntry[],
): (kind: Kind, name: string) => boolean {
  const have = new Set(entries.map((e) => `${e.kind}:${e.name.toLowerCase()}`));
  return (kind, name) => have.has(`${kind}:${name.toLowerCase()}`);
}

/** The words that install one preload (`incident`, `mcp:slack`). */
function wordOf(m: PreloadGap['missing'][number]): string {
  return m.kind === 'mcp' ? `mcp:${m.name}` : m.name;
}

/** The gap of one agent, or undefined when everything it preloads is installed. */
export function gapOf(
  run: Run,
  job: { agent: Entity; source: string; index?: SourceIndex },
  has: (kind: Kind, name: string) => boolean,
): PreloadGap | undefined {
  const missing = preloadsOf(job.agent).filter((p) => !has(p.kind, p.name));
  if (!missing.length) return undefined;
  const gap: PreloadGap = { agent: { name: job.agent.name, source: job.source }, missing };
  const { index } = job;
  const offered = (m: PreloadGap['missing'][number]) =>
    !index || index.entities.some((e) => e.kind === m.kind && sameName(e.name, m.name));
  const here = missing.filter(offered);
  const elsewhere = missing.filter((m) => !offered(m)).map((m) => m.name);
  if (here.length)
    gap.command = palmCommand('install', [job.source, ...here.map(wordOf)], run.state.paths.scope);
  if (elsewhere.length) gap.elsewhere = elsewhere;
  return gap;
}

/** `agent reviewer preloads skill incident, not installed: palm install acme incident`. */
export function preloadLine(gap: PreloadGap): string {
  const what = gap.missing.map((m) => `${m.kind} ${m.name}`).join(', ');
  const tail = gap.command ? `: ${gap.command}` : '';
  const other = gap.elsewhere?.length
    ? ` (${gap.elsewhere.join(', ')} not in source ${gap.agent.source})`
    : '';
  return `agent ${gap.agent.name} preloads ${what}, not installed${tail}${other}`;
}

/** An installed agent's entity from the index at the locked commit; undefined when unavailable. */
async function lockedAgent(
  run: Run,
  entry: LockEntry,
): Promise<{ agent: Entity; index: SourceIndex } | undefined> {
  const ref = sourceRefOf(run.state, entry.source);
  if (!ref) return undefined;
  const sha = lockedSource(run.state, entry.source)?.sha;
  try {
    const { ctx, deps, state } = run;
    const r = await resolveSource({ ctx, deps, state, ref, ...(sha ? { sha } : {}) });
    const agent = r.index.entities.find((e) => e.kind === 'agent' && sameName(e.name, entry.name));
    return agent ? { agent, index: r.index } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every installed agent's preloads that nothing in the scope provides, read from the index at
 * the locked commit (the cache; an agent whose source cannot be read is skipped). For `check`
 * (warning `agent reviewer preloads skill incident, not installed: …`).
 */
export async function missingPreloads(run: Run): Promise<PreloadGap[]> {
  const entries = run.state.lock.entries;
  const has = installedNames(entries);
  const gaps: PreloadGap[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'agent') continue;
    const found = await lockedAgent(run, entry);
    const gap = found && gapOf(run, { ...found, source: entry.source }, has);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

/** After a remove: the preload line for each installed agent that preloads what left (K3). */
export async function notePreloadsLeaving(run: Run, removed: readonly LockEntry[]): Promise<void> {
  const left = removed.filter((e) => e.kind === 'skill' || e.kind === 'mcp');
  if (!left.length) return;
  const gone = installedNames(left);
  const has = (kind: Kind, name: string) => !gone(kind, name);
  for (const gap of await missingPreloads(run)) {
    const lost = gap.missing.filter((m) => !has(m.kind, m.name));
    if (!lost.length) continue;
    const source = left.find((e) => lost.some((m) => sameName(m.name, e.name)))?.source;
    const words = lost.map((m) => (m.kind === 'mcp' ? `mcp:${m.name}` : m.name));
    const command = source
      ? palmCommand('install', [source, ...words], run.state.paths.scope)
      : undefined;
    run.ctx.log.info(
      preloadLine({ agent: gap.agent, missing: lost, ...(command ? { command } : {}) }),
    );
  }
}
