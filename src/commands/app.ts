/**
 * What every command module receives besides its `Invocation`: the output writer and the
 * pieces of the process a test may replace. Types only (loaded by `palm --help`).
 */
import type { Command } from 'commander';
import type { EngineDeps, UI } from '../core/types.js';
import type { Output } from '../ui/output.js';
import type { Invocation } from './grammar.js';

export interface App {
  out: Output;
  /** Arguments after `--` (ad hoc MCP server command), split off before commander parses. */
  passthrough: string[];
  /** The root command (shell completion reads the tree from it). */
  program?: Command;
  /** Tests: a fake UI instead of clack / the non-interactive UI. */
  ui?: UI;
  /** Tests: working directory and environment (default: the process's). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: engine collaborators (fake targets, scanner). */
  deps?: Partial<EngineDeps>;
}

/** A command module's entry point. */
export type Runner = (inv: Invocation, app: App) => Promise<void>;
