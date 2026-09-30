/**
 * `palm install mcp` (DESIGN.md §9): a server by flags (`--url`, `--header`, `--command`,
 * `--arg`, `--env`, `--transport`, `--cwd`) or every server of a README snippet
 * (`--snippet <file>`, `--snippet -` for stdin). Each becomes an `mcp:` entry in palm.yaml and is
 * rendered for every target; a stdio server goes through the consent prompt.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import type { McpServerConfig } from '../core/types.js';
import { parseAdhocMcp } from './adhoc.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { interruptible, reportInstall } from './report.js';
import {
  engine,
  engineDeps,
  type GlobalOptions,
  makeContext,
  parseTargetList,
  scopeOf,
} from './shared.js';

interface McpFlags extends GlobalOptions {
  url?: string;
  header?: string[];
  command?: string;
  arg?: string[];
  env?: string[];
  transport?: string;
  cwd?: string;
  /** `--snippet <file or ->`: the README block. */
  snippet?: string;
  targets?: string;
}

const EXAMPLE = 'palm install mcp docs --url https://example.com/mcp';
const SNIPPET_HINT = 'paste the { "mcpServers": { ... } } block from the server README';

function fromFlags(names: string[], flags: McpFlags): McpServerConfig {
  const [name] = names;
  if (!name || names.length > 1)
    throw usage(name ? 'palm install mcp takes one server name' : 'name the MCP server', EXAMPLE);
  return parseAdhocMcp(name, {
    command: flags.command,
    args: flags.arg,
    url: flags.url,
    headers: flags.header,
    env: flags.env,
    transport: flags.transport,
    cwd: flags.cwd,
  });
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
  return chunks.join('');
}

async function snippetText(app: App, file: string): Promise<string> {
  if (file === '-') {
    const stdin = app.stdin ?? process.stdin;
    if ((stdin as { isTTY?: boolean }).isTTY) app.out.hint(`${SNIPPET_HINT}, then press Ctrl-D`);
    return readStream(stdin);
  }
  const abs = resolve(app.cwd ?? process.cwd(), file);
  return readFile(abs, 'utf8').catch(() => {
    throw new PalmError(
      'E_NOT_FOUND',
      `cannot read ${file}`,
      'pbpaste | palm install mcp --snippet -',
    );
  });
}

function parseSnippet(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const where = file === '-' ? 'the snippet on stdin' : file;
    throw new PalmError('E_PARSE', `${where} is not JSON: ${messageOf(e)}`, SNIPPET_HINT);
  }
}

/** The servers the command line names, or all of them; one server may be renamed. */
function pickServers(servers: McpServerConfig[], names: string[], file: string): McpServerConfig[] {
  if (!servers.length)
    throw new PalmError('E_PARSE', 'the snippet holds no MCP server', SNIPPET_HINT);
  const only = servers[0] as McpServerConfig;
  if (names.length === 1 && servers.length === 1) return [{ ...only, name: names[0] as string }];
  if (!names.length && servers.some((s) => !s.name))
    throw usage('the snippet does not name its server', `palm install mcp docs --snippet ${file}`);
  if (!names.length) return servers;
  return names.map((n) => {
    const found = servers.find((s) => s.name === n);
    if (found) return found;
    const listed = servers.map((s) => s.name).join(', ');
    throw new PalmError(
      'E_NOT_FOUND',
      `the snippet has no server "${n}" (it has ${listed})`,
      `palm install mcp --snippet ${file}`,
    );
  });
}

async function fromSnippet(app: App, file: string, names: string[]): Promise<McpServerConfig[]> {
  const json = parseSnippet(await snippetText(app, file), file);
  const servers = await engine(app).parseMcpJson(json);
  return pickServers(servers, names, file).map((s) => ({
    ...s,
    from: s.from ?? { type: 'snippet' },
  }));
}

function checkFlags(flags: McpFlags): void {
  const serverFlags = [flags.url, flags.command, flags.header, flags.arg, flags.env, flags.cwd];
  if (flags.snippet !== undefined && serverFlags.some((f) => f !== undefined))
    throw usage(
      '--snippet takes the whole server from the snippet; drop --url, --command and their flags',
      `palm install mcp --snippet ${flags.snippet}`,
    );
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as McpFlags;
  checkFlags(flags);
  const names = inv.names.map((n) => n.name);
  const targets = parseTargetList(flags.targets, '--targets');
  const configs =
    flags.snippet === undefined
      ? [fromFlags(names, flags)]
      : await fromSnippet(app, flags.snippet, names);
  const ctx = await makeContext(app, flags);
  const api = engine(app);
  const scope = scopeOf(flags);
  const before = await api.openScope(ctx, scope, { readOnly: true });
  const reqs = configs.map((config) => (targets ? { config, targets } : { config }));
  const opts = { scope, force: ctx.flags.force };
  const result = await interruptible(app, () => api.installMcp(ctx, reqs, opts, engineDeps(app)));
  const after = await api.openScope(ctx, scope, { readOnly: true });
  await reportInstall(ctx, app, result, { before, after });
}
