import type { Command } from 'commander';
import pc from 'picocolors';
import type { InstallRequest, InstallResult, Kind, LockEntry, OriginSpec, Scope, SecretPolicy, TargetId } from '../core/types.js';
import { printInstallSummary } from '../ui/output.js';
import {
  collect,
  createRootProgram,
  makeContext,
  parseSecretPolicy,
  parseTargetList,
  printJson,
  scopeOf,
  splitKindArgs,
  splitPassthrough,
  usage,
  type GlobalOptions,
} from './shared.js';

export interface AdhocMcpArgs {
  name: string;
  /** Command + args given after `--`. */
  command?: string[];
  url?: string;
  headers: string[];
  env: string[];
  transport?: string;
}

export interface ParsedInstallArgs {
  /** `sync` = bare `palm install` (install what palm.yaml lists). */
  mode: 'install' | 'sync';
  kind?: Kind;
  specs: string[];
  from?: string;
  saveOrigin: boolean;
  secrets?: SecretPolicy;
  prune: boolean;
  adhoc?: AdhocMcpArgs;
  scope: Scope;
  targets?: TargetId[];
  global: GlobalOptions;
}

interface InstallCliOptions extends GlobalOptions {
  from?: string;
  saveOrigin?: boolean;
  secrets?: string;
  prune?: boolean;
  url?: string;
  header?: string[];
  env?: string[];
  transport?: string;
}

const ADHOC_HINT = 'palm install mcp <name> -- <command> [args...]   or   palm install mcp <name> --url <url> [--header K=V]';

/** Pure interpretation of already-tokenised install arguments. */
export function interpretInstallArgs(positional: string[], opts: InstallCliOptions, passthrough: string[]): ParsedInstallArgs {
  const { kind, rest: specs } = splitKindArgs(positional);
  const headers = opts.header ?? [];
  const env = opts.env ?? [];
  const adhocRequested = passthrough.length > 0 || Boolean(opts.url) || headers.length > 0 || env.length > 0 || Boolean(opts.transport);

  let adhoc: AdhocMcpArgs | undefined;
  if (adhocRequested) {
    if (kind !== 'mcp') throw usage('`--`, --url, --header, --env and --transport define an ad hoc MCP server and need the mcp kind', ADHOC_HINT);
    if (specs.length !== 1) throw usage('an ad hoc MCP server needs exactly one name', ADHOC_HINT);
    if (passthrough.length === 0 && !opts.url) throw usage('an ad hoc MCP server needs a command after `--` or --url', ADHOC_HINT);
    if (passthrough.length > 0 && opts.url) throw usage('give either a command after `--` or --url, not both', ADHOC_HINT);
    adhoc = {
      name: specs[0]!,
      command: passthrough.length ? passthrough : undefined,
      url: opts.url,
      headers,
      env,
      transport: opts.transport,
    };
  }

  const mode = specs.length === 0 ? 'sync' : 'install';
  if (mode === 'sync' && kind) {
    throw usage(`name the ${kind} to install`, 'run `palm install` with no arguments to install everything listed in palm.yaml');
  }
  if (opts.prune && mode !== 'sync') throw usage('--prune only applies to a bare `palm install` (manifest sync)');
  if (opts.saveOrigin && !opts.from) throw usage('--save-origin needs --from <origin>');

  const global: GlobalOptions = {
    global: opts.global,
    target: opts.target,
    dryRun: opts.dryRun,
    force: opts.force,
    yes: opts.yes,
    offline: opts.offline,
    verbose: opts.verbose,
    json: opts.json,
  };

  return {
    mode,
    kind,
    specs,
    from: opts.from,
    saveOrigin: Boolean(opts.saveOrigin),
    secrets: parseSecretPolicy(opts.secrets),
    prune: Boolean(opts.prune),
    adhoc,
    scope: scopeOf(global),
    targets: parseTargetList(opts.target),
    global,
  };
}

export function registerInstall(
  program: Command,
  passthrough: string[],
  handler: (parsed: ParsedInstallArgs) => void | Promise<void> = runInstall,
): void {
  program
    .command('install')
    .aliases(['i', 'add'])
    .summary('install skills, agents, MCP servers, plugins… (no args: everything in palm.yaml)')
    .description('Install entities from your origins into the active targets. With no arguments, install everything palm.yaml lists.')
    .argument('[kind]', 'skill, agent, instruction, command, hook, mcp or plugin (plurals ok); omit to search all kinds')
    .argument('[specs...]', 'name[@origin][#ref]')
    .option('--from <origin>', 'take the entities from this origin spec (owner/repo, URL, path) without registering it')
    .option('--save-origin', 'register the --from origin')
    .option('--secrets <policy>', 'MCP secret placement: env-ref (project default) or literal (-g default)')
    .option('--prune', 'bare install only: remove installed entries no longer in palm.yaml')
    .option('--url <url>', 'ad hoc MCP server: HTTP/SSE endpoint')
    .option('--header <K=V>', 'ad hoc MCP server: HTTP header (repeatable)', collect)
    .option('--env <K=V>', 'ad hoc MCP server: environment variable (repeatable)', collect)
    .option('--transport <t>', 'ad hoc MCP server: stdio, http or sse')
    .addHelpText(
      'after',
      `
Spec grammar: name[@origin][#ref]
  name       entity name (skill dir / agent file / MCP server key / plugin name)
  @origin    origin alias from \`palm origin list\` (needed when several origins have the name)
  #ref       tag, branch or commit of that origin (default: its latest semver tag)
  MCP registry servers go by their registry name: palm install mcp io.github.upstash/context7

Ad hoc MCP servers (no origin needed):
  palm install mcp <name> [--env K=V]... -- <command> [args...]
  palm install mcp <name> --url <url> [--header K=V]... [--transport http|sse]
  \${VAR} in values stays an environment reference (env-ref) or is filled in (literal).

Examples:
  palm install                                   install everything in palm.yaml
  palm install skill wayfinder@mattpocock
  palm install skills tdd grill-me               several of one kind
  palm install wayfinder                         search every kind
  palm install skill tdd@mattpocock#v1.2.3       pin a tag
  palm i agent reviewer -g --target claude,codex
  palm install plugin superpowers                all its skills, hooks, agents…
  palm install mcp fs -- npx -y @modelcontextprotocol/server-filesystem .
  palm install mcp docs --url https://example.com/mcp --header "Authorization=Bearer \${DOCS_TOKEN}"`,
    )
    .action((kind: string | undefined, specs: string[], _opts: unknown, cmd: Command) => {
      const positional = [...(kind === undefined ? [] : [kind]), ...specs];
      return handler(interpretInstallArgs(positional, cmd.optsWithGlobals<InstallCliOptions>(), passthrough));
    });
}

/** Parse a full user argv (e.g. `['i', 'agent', 'x', '-g']`) exactly as the CLI would, without running anything. */
export function parseInstallArgs(argv: string[]): ParsedInstallArgs {
  const { args, passthrough } = splitPassthrough(argv);
  let parsed: ParsedInstallArgs | undefined;
  const program = createRootProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerInstall(program, passthrough, (p) => {
    parsed = p;
  });
  program.parse(args, { from: 'user' });
  if (!parsed) throw usage(`not an install command: ${argv.join(' ')}`);
  return parsed;
}

export async function runInstall(parsed: ParsedInstallArgs): Promise<void> {
  const g = parsed.global;
  const ctx = await makeContext(g);
  const { resolveTargets } = await import('../engine/resolve-targets.js');

  if (parsed.mode === 'sync') {
    const targets: TargetId[] = await resolveTargets(ctx, { scope: parsed.scope, flag: parsed.targets, save: true });
    const { syncManifest } = await import('../engine/sync.js');
    const result: InstallResult & { extraneous: LockEntry[] } = await syncManifest(ctx, {
      scope: parsed.scope,
      prune: parsed.prune,
      targets,
      ...(parsed.secrets ? { secretPolicy: parsed.secrets } : {}),
    });
    if (g.json) return printJson(result);
    printInstallSummary(result, { scope: parsed.scope, targets });
    if (result.extraneous.length) {
      console.log('');
      const names = result.extraneous.map((e) => `${e.kind} ${e.name}`).join(', ');
      if (parsed.prune) console.log(`${pc.green('✓')} removed ${result.extraneous.length} entr${result.extraneous.length === 1 ? 'y' : 'ies'} not in palm.yaml: ${names}`);
      else console.log(pc.yellow(`⚠ installed but not in palm.yaml: ${names}`) + pc.dim('\n  run `palm install --prune` to remove them'));
    }
    if (g.dryRun) console.log(pc.dim(`\n${DRY_RUN_NOTE}`));
    return;
  }

  let from: OriginSpec | undefined;
  if (parsed.from) {
    const { parseOriginInput, addOrigin } = await import('../core/config.js');
    from = parseOriginInput(parsed.from);
    if (parsed.saveOrigin) {
      if (ctx.flags.dryRun) {
        ctx.log.info(`dry run: would register origin ${from.alias}`);
      } else {
        from = await addOrigin(ctx, from, { scope: parsed.scope });
        ctx.log.success(`registered origin ${from.alias}`);
      }
    }
  }

  let requests: InstallRequest[];
  if (parsed.adhoc) {
    const { parseAdhocMcp } = await import('../mcp/adhoc.js');
    const a = parsed.adhoc;
    const adhocMcp = parseAdhocMcp(a.name, { command: a.command, url: a.url, headers: a.headers, env: a.env, transport: a.transport });
    requests = [{ kind: 'mcp', spec: a.name, adhocMcp }];
  } else {
    requests = parsed.specs.map((spec) => ({ kind: parsed.kind, spec, from }));
  }

  // Resolve targets only after the requests parsed, so bad input fails before any prompt.
  const targets: TargetId[] = await resolveTargets(ctx, { scope: parsed.scope, flag: parsed.targets, save: true });
  const { installEntities } = await import('../engine/install.js');
  const result: InstallResult = await installEntities(ctx, requests, { scope: parsed.scope, targets, secretPolicy: parsed.secrets });
  if (g.json) return printJson(result);
  printInstallSummary(result, { scope: parsed.scope, targets });
  if (g.dryRun) console.log(pc.dim(`\n${DRY_RUN_NOTE}`));
}

/** What --dry-run does and does not touch (origins are still fetched so the plan is real). */
export const DRY_RUN_NOTE = 'dry run: no harness files, lockfile or manifest were changed (origins were fetched into the palm cache as needed)';
