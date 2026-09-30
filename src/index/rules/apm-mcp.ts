/**
 * `dependencies.mcp` of an `apm.yml` (ruling R10'): APM wires those servers into the consumer's
 * harness configs; palm never follows a dependency, so one note names the servers and the command
 * that installs each: `palm install mcp <name> --command …` for a local server, `--url …` for a
 * remote one, and `--snippet` for a registry name (its README holds the JSON).
 */

import { isRecord } from '../../lib/object.js';
import { shellWord } from '../notes.js';
import { asString } from '../util.js';

/** How to install one declared server; the registry form has only a name. */
function installLine(dep: unknown): { name: string; line: string } | undefined {
  if (typeof dep === 'string' && dep.trim() !== '') {
    const name = dep.trim();
    return { name, line: `palm install mcp --snippet <the JSON from ${name}'s README>` };
  }
  if (!isRecord(dep)) return undefined;
  const name = asString(dep.name);
  if (!name) return undefined;
  const url = asString(dep.url);
  const command = asString(dep.command);
  const args = Array.isArray(dep.args) ? dep.args.map((a) => String(a)) : [];
  const words = ['palm', 'install', 'mcp', name];
  if (url) words.push('--url', url);
  else if (command) words.push('--command', command, ...args.flatMap((a) => ['--arg', a]));
  else return { name, line: 'palm install mcp --snippet <its mcpServers JSON>' };
  return { name, line: words.map(shellWord).join(' ') };
}

/** One note for `dependencies.mcp`, or undefined when the manifest lists none. */
export function apmMcpNote(apmFile: string, data: Record<string, unknown>): string | undefined {
  const deps = isRecord(data.dependencies) ? data.dependencies.mcp : undefined;
  if (!Array.isArray(deps)) return undefined;
  const found = deps.map(installLine).filter((d) => d !== undefined);
  if (found.length === 0) return undefined;
  const what =
    found.length === 1
      ? '1 MCP server dependency is'
      : `${found.length} MCP server dependencies are`;
  const names = found.map((d) => d.name).join(', ');
  const lines = found.map((d) => d.line).join('; ');
  return `${apmFile}: ${what} not installed (${names}); palm installs a server with: ${lines}`;
}
