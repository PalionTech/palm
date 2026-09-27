import type { Command } from 'commander';
import { registerConfig } from './config.js';
import { registerCreate } from './create.js';
import { registerDoctor } from './doctor.js';
import { registerInfo } from './info.js';
import { registerInit } from './init.js';
import { registerInstall } from './install.js';
import { registerList } from './list.js';
import { registerOrigin } from './origin.js';
import { registerSearch } from './search.js';
import { registerTargets } from './targets.js';
import { registerUninstall } from './uninstall.js';
import { registerUpdate } from './update.js';
import { createRootProgram } from './shared.js';

export interface ProgramOptions {
  version?: string;
  /** Arguments after `--` (ad hoc MCP server command), split off before commander parses. */
  passthrough?: string[];
}

/** The full `palm` command tree. Sibling modules are imported lazily inside actions. */
export function buildProgram(opts: ProgramOptions = {}): Command {
  const program = createRootProgram();
  if (opts.version) program.version(opts.version, '-V, --version', 'print the palm version');
  registerInstall(program, opts.passthrough ?? []);
  registerUninstall(program);
  registerList(program);
  registerSearch(program);
  registerInfo(program);
  registerUpdate(program);
  registerOrigin(program);
  registerCreate(program);
  registerInit(program);
  registerTargets(program);
  registerConfig(program);
  registerDoctor(program);
  return program;
}
