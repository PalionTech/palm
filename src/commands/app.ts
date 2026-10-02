/**
 * What every command module receives besides its `Invocation`: the output writer and the
 * pieces of the process a test may replace. Types only (loaded by `palm --help`).
 */
import type { Command } from 'commander';
import type { UI } from '../core/types.js';
import type { CliDeps } from '../create/engine.js';
import type { Output } from '../ui/output.js';
import type { Invocation } from './grammar.js';

export interface App {
  out: Output;
  /** Where `install mcp --snippet -` reads the snippet (default: process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** The root command (shell completion reads the tree from it). */
  program?: Command;
  /** Tests: a fake UI instead of clack or the non-interactive UI. */
  ui?: UI;
  /** Tests: working directory and environment (default: the process's). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Engine collaborators and replacements for engine operations (tests). */
  deps?: CliDeps;
  /** The command line before `--`, for hints that repeat it. */
  argv: string[];
  /** The words after `--`. */
  passthrough: string[];
  /** Set while an install runs: what the first Ctrl-C does (stop after the current entity). */
  onInterrupt?: () => void;
  /** The first Ctrl-C arrived while an install ran. */
  interrupted?: boolean;
}

/** A command module's entry point. */
export type Runner = (inv: Invocation, app: App) => Promise<void>;
