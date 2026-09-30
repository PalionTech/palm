/**
 * What a harness supplies to the generic target: where each kind goes at a scope
 * (`TargetLayout`) and how to detect the harness (`TargetSpec`). One small strategy object per
 * harness (claude.ts, codex.ts, copilot.ts, cursor.ts, gemini.ts, opencode.ts); rendering,
 * applying and undeploying are shared.
 *
 * Layout paths are absolute. Global scope expands the harness homes through `ScopePaths`
 * (overrides applied), and everything palm records goes back through `ScopePaths.lockForm`,
 * so a global lock names `<claude>/skills/x`, never a machine path.
 */
import path from 'node:path';
import type { TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';

/** The name a person knows each harness by (messages and notes). */
export const DISPLAY_NAMES: Readonly<Record<TargetId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

export interface CleanupRoot {
  /** Directory this target writes into. */
  dir: string;
  /** Directory never removed when pruning empty parents (e.g. `.claude`, `.github`). */
  stop: string;
}

/**
 * A JSON array the instruction file is also listed in (OpenCode `opencode.json#/instructions`).
 */
interface InstructionList {
  json: string;
  path: string[];
}

export interface TargetLayout {
  /** Config dir reported by configDir(). */
  configDir: string;
  /**
   * Directory holding `<name>/` skill directories, given the targets active for the entry
   * (cursor: `.claude/skills` when claude is active, else `.agents/skills`).
   */
  skillsDir(active: readonly TargetId[]): string;
  agentsDir: string;
  /**
   * One file per instruction in `dir` (optionally also listed in a JSON array, `list`), or a
   * palm-managed block in the shared markdown file `blockFile` (`AGENTS.md`, `GEMINI.md`).
   * `skip`: the note for a documented gap; `<name>` stands for the entity's name.
   */
  instructions: { dir: string; list?: InstructionList } | { blockFile: string } | { skip: string };
  /** Merge into a shared hooks file, write a standalone `<name>.json` into `dir`, or skip. */
  hooks: { mergeFile: string; versioned?: boolean } | { dir: string } | { skip: string };
  /** MCP servers: keys of the JSON object at `path`, or `[mcp_servers.<name>]` TOML tables. */
  mcp: { json: string; path: string[] } | { toml: string };
  /** Directories this target writes files into (claims them at undeploy). */
  roots: CleanupRoot[];
  /** Shared files outside `roots` this target merges into. */
  mergedFiles: string[];
}

export interface TargetSpec {
  id: TargetId;
  displayName: string;
  layout(paths: ScopePaths): TargetLayout;
  detect(paths: ScopePaths): Promise<boolean>;
  /** Directories the target writes into at the scope, lock form (overlap checks). */
  outputDirs(paths: ScopePaths): string[];
}

/**
 * `<root>/.agents/skills` (`<agents>/skills` at global scope): the skills directory Codex,
 * Copilot, Cursor, Gemini CLI and OpenCode share. Each claims it at undeploy (whichever runs
 * first removes a skill), pruning up to `.agents`.
 */
export function sharedSkillsRoot(paths: ScopePaths): CleanupRoot {
  const agents =
    paths.scope === 'project' ? path.join(paths.root, '.agents') : paths.token('agents');
  return { dir: path.join(agents, 'skills'), stop: agents };
}

/** A skills directory that does not depend on the other active targets. */
export function fixedSkillsDir(root: CleanupRoot): TargetLayout['skillsDir'] {
  return () => root.dir;
}

/** The lock form of every root a layout writes into, deduplicated and sorted. */
export function outputDirsOf(layout: TargetLayout, paths: ScopePaths): string[] {
  return [...new Set(layout.roots.map((r) => paths.lockForm(r.dir)))].sort();
}

/** A boolean environment flag as the harnesses read it: `true` or `1`, any case. */
export function flagSet(value: string | undefined): boolean {
  const v = value?.toLowerCase();
  return v === 'true' || v === '1';
}

/** True when an environment variable holds a value (an override is in effect). */
export function envSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? '') !== '';
}
