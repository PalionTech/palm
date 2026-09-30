/**
 * `foreign-servers` (Sofia S2, V2'): every MCP file palm parses (`.mcp.json`, `.cursor/mcp.json`,
 * `.vscode/mcp.json`, `.codex/config.toml`, …) read for stdio servers, the ones that run a
 * program. A stdio server no lock entry merged into that file is foreign: a warning, a failure
 * under `--strict`, with the file its command names when that file is missing (X14). Servers
 * over HTTP run nothing on the machine and are not listed. Nothing is written.
 */
import type { CheckRun } from '../core/types.js';
import { visible } from '../exec/format.js';
import { formatPointer } from '../lib/json-pointer.js';
import { isRecord } from '../lib/object.js';
import { type McpFile, mcpFiles } from './check-harness.js';
import { type CheckContext, checkRun, count, found } from './check-kit.js';
import { missingScript } from './check-scripts.js';
import { readConfig } from './rotate.js';

/** A stdio server on disk that no lock entry explains. */
interface ServerFinding {
  /** Lock form. */
  file: string;
  name: string;
  command: string;
  missing?: string;
}

/** The server map of an MCP file, as the harness reads it. */
async function serversIn(c: CheckContext, f: McpFile): Promise<Record<string, unknown>> {
  let node = await readConfig(c.run.state.paths.abs(f.file));
  for (const segment of f.path) node = isRecord(node) ? node[segment] : undefined;
  return isRecord(node) ? node : {};
}

/** The command line a stdio server runs (`npx -y pkg`), or undefined for a remote server. */
function stdioCommand(server: unknown): string | undefined {
  if (!isRecord(server)) return undefined;
  const { command, args } = server;
  const words = Array.isArray(command) ? command : [command];
  if (typeof words[0] !== 'string' || words[0] === '') return undefined;
  const rest = Array.isArray(args) ? args : [];
  return [...words, ...rest].filter((w): w is string => typeof w === 'string').join(' ');
}

/** `file#at` of every server the lock merged into an MCP file. */
function explained(c: CheckContext): Set<string> {
  return new Set(
    c.run.state.lock.entries.flatMap((e) => (e.merged ?? []).map((m) => `${m.file}#${m.at}`)),
  );
}

/** Every stdio server in an MCP file palm parses that no lock entry merged there. */
async function serverFindings(c: CheckContext): Promise<ServerFinding[]> {
  const known = explained(c);
  const out: ServerFinding[] = [];
  for (const f of mcpFiles(c))
    for (const [name, server] of Object.entries(await serversIn(c, f))) {
      const command = stdioCommand(server);
      if (command === undefined || known.has(`${f.file}#${formatPointer([...f.path, name])}`))
        continue;
      const finding: ServerFinding = { file: f.file, name, command };
      const missing = missingScript(c.run.state.paths, command);
      if (missing) finding.missing = missing;
      out.push(finding);
    }
  return out;
}

/** Sofia S2: a stdio server palm did not install in an MCP file it parses (warning). */
export async function foreignServers(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const s of await serverFindings(c)) {
    const missing = s.missing ? `; script missing: ${s.missing}` : '';
    f.warn.push({
      file: s.file,
      message: `foreign stdio server ${visible(s.name)} in ${s.file}: ${visible(s.command)}${missing}`,
      fix: `keep it if you added it; else remove it from ${s.file} (palm does not manage it)`,
    });
  }
  return checkRun(
    'foreign-servers',
    {
      ok: 'no foreign stdio server in the MCP files palm manages',
      bad: (n) => `${count(n, 'foreign stdio server')} in the MCP files palm manages`,
    },
    f,
  );
}
