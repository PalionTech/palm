/**
 * What a harness supplies to the generic target: where each kind goes at a scope
 * (`TargetLayout`) and how to detect the harness (`TargetSpec`). One small strategy object per
 * harness (claude.ts, codex.ts, copilot.ts, cursor.ts, gemini.ts, opencode.ts); deploy and
 * undeploy are shared.
 */
import type { TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';

export interface CleanupRoot {
  /** Directory this target writes into. */
  dir: string;
  /** Directory never removed when pruning empty parents (e.g. `.claude`, `.github`). */
  stop: string;
}

export interface TargetLayout {
  /** Config dir reported by configDir(). */
  configDir: string;
  /** Directory holding `<name>/` skill directories. */
  skillsDir: string;
  agentsDir: string;
  /**
   * One file per instruction in `dir` (optionally also listed in a JSON array, `list`), or a
   * palm-managed block in the shared markdown file `blockFile` (`AGENTS.md`, `GEMINI.md`).
   * `skip`: the note for a documented gap; `<name>` stands for the entity's name.
   */
  instructions: { dir: string; list?: InstructionList } | { blockFile: string } | { skip: string };
  commands: { dir: string } | { skip: string };
  /** Merge into a shared hooks file, write a standalone `<name>.json` into `dir`, or skip. */
  hooks: { mergeFile: string; versioned?: boolean } | { dir: string } | { skip: string };
  /** MCP servers: keys of the JSON object at `path`, or `[mcp_servers.<name>]` TOML tables. */
  mcp: { json: string; path: string[] } | { toml: string };
  /** Directories this target writes files into (claims them at undeploy). */
  roots: CleanupRoot[];
  /** Shared files outside `roots` this target merges into. */
  mergedFiles: string[];
}

/**
 * A JSON array the instruction file is also listed in (OpenCode `opencode.json#/instructions`).
 * The entry is the file's lock form: project-relative at project scope, absolute at global scope.
 */
export interface InstructionList {
  json: string;
  path: string[];
}

export interface TargetSpec {
  id: TargetId;
  displayName: string;
  layout(paths: ScopePaths): TargetLayout;
  detect(paths: ScopePaths): Promise<boolean>;
}
