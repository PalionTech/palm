/**
 * The `palm` command tree: verbs first, then utilities, then the hidden aliases of the old
 * grammar (`palm origin add|list|remove|update|import`, `palm targets`). Registration only:
 * every action turns its arguments into an `Invocation` and hands it to `dispatch`, which
 * imports the command module lazily, so `palm --help` loads commander and picocolors only.
 */
import { Command, Help } from 'commander';
import {
  type Dispatch,
  type Invocation,
  interpretWords,
  splitPassthrough,
  usage,
  VERBS,
  type Verb,
  type VerbSpec,
} from './grammar.js';
import {
  AUDIT_HELP,
  CACHE_HELP,
  COMPLETION_HELP,
  CONFIG_HELP,
  DOCTOR_HELP,
  FIND_HELP,
  INIT_HELP,
  OUTDATED_HELP,
  ROOT_HELP,
  VERB_HELP,
  WHY_HELP,
} from './help.js';

export interface ProgramOptions {
  version?: string;
  dispatch: Dispatch;
  /** Where commander writes help and its own errors (default: process streams). */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

/** Collect a repeatable option into an array. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

const VERB_NAMES = new Set<string>(VERBS.map((v) => v.name));

/** `install (add, i)` for verbs; utilities keep their arguments (`completion <shell>`). */
function subcommandTerm(cmd: Command): string {
  const aliases = cmd.aliases();
  const name = aliases.length ? `${cmd.name()} (${aliases.join(', ')})` : cmd.name();
  if (VERB_NAMES.has(cmd.name()) && !cmd.parent?.parent) return name;
  const args = cmd.registeredArguments
    .map((a) => {
      const n = `${a.name()}${a.variadic ? '...' : ''}`;
      return a.required ? `<${n}>` : `[${n}]`;
    })
    .join(' ');
  return args ? `${name} ${args}` : name;
}

/** Root help lists the verbs and utilities first and the global options after them. */
function formatHelp(this: Help, cmd: Command, helper: Help): string {
  const text = Help.prototype.formatHelp.call(this, cmd, helper);
  if (cmd.parent) return text;
  const blocks = text.trimEnd().split('\n\n');
  const i = blocks.findIndex((b) => b.startsWith('Options:'));
  if (i < 0) return text;
  const options = blocks.splice(i, 1);
  return `${[...blocks, ...options].join('\n\n')}\n`;
}

/**
 * Root `palm` command with the global options and shared settings, no subcommands.
 * `exitOverride` and the output configuration are set before subcommands are added so they
 * inherit them: commander throws `CommanderError` instead of exiting (main.ts maps it to 2).
 */
export function createRootProgram(opts: Omit<ProgramOptions, 'dispatch'> = {}): Command {
  const program = new Command('palm')
    .exitOverride()
    .usage('<verb> [kind] [names...] [options]')
    .description(
      'Package manager for agent resources: skills, agents, instructions, commands, hooks, MCP servers and plugins.',
    )
    .option('-g, --global', 'use the global scope (~), not this project')
    .option('-t, --target <ids>', 'targets: claude,codex,copilot,cursor')
    .option('--dry-run', 'show what would change; write nothing')
    .option('--force', 'overwrite files palm does not own')
    .option('-y, --yes', 'accept defaults instead of prompting')
    .option('--offline', 'use cached origins only; no network')
    .option('--verbose', 'debug output and stack traces')
    .option('--json', 'JSON on stdout; everything else on stderr')
    .option('--no-color', 'no colours (also NO_COLOR=1)')
    .configureHelp({
      showGlobalOptions: true,
      sortSubcommands: false,
      subcommandTerm,
      formatHelp,
    })
    .showSuggestionAfterError(true);
  if (opts.writeOut || opts.writeErr) {
    program.configureOutput({
      ...(opts.writeOut ? { writeOut: opts.writeOut } : {}),
      ...(opts.writeErr ? { writeErr: opts.writeErr } : {}),
    });
  }
  if (opts.version) program.version(opts.version, '-V, --version', 'print the palm version');
  return program;
}

function invocation(verb: Verb, words: Array<string | undefined>, cmd: Command): Invocation {
  const { resource, names } = interpretWords(
    verb,
    words.filter((w): w is string => w !== undefined),
  );
  return { command: verb, resource, names, opts: cmd.optsWithGlobals() };
}

const OMITTED: Partial<Record<Verb, string>> = {
  install: 'omit it to search every entity kind',
  uninstall: 'omit it to match every entity kind',
  get: 'omit it for every installed entity',
  update: 'omit it for everything installed',
};

function kindArgHelp(spec: VerbSpec): string {
  const list = spec.resources.join(', ');
  const omitted = OMITTED[spec.name];
  return `${list} (plurals and short names work)${omitted ? `; ${omitted}` : ''}`;
}

const VERB_OPTIONS: Partial<Record<Verb, (cmd: Command) => void>> = {
  install: installOptions,
  get: (cmd) => {
    cmd.option('--available', 'list what your origins offer instead of what is installed');
    originFilter(cmd);
  },
  describe: originFilter,
  search: (cmd) => {
    cmd.option('--kind <kind>', 'restrict to one kind (same as the kind word)');
    originFilter(cmd);
    cmd.option('--refresh', 'refetch origins before searching');
  },
  create: (cmd) => {
    cmd.option('--no-install', 'only write the file; do not install it');
  },
};

function originFilter(cmd: Command): void {
  cmd.option(
    '-o, --origin <name-or-alias>',
    'only this origin: alias, owner/repo[/root], URL or local path (installed entities also: mine, registry, adhoc)',
  );
}

function originOptions(cmd: Command): Command {
  return cmd
    .option('--alias <alias>', 'short name used in name@alias (default: repo name)')
    .option('--ref <ref>', 'tag, branch or sha (default: latest semver tag, else default branch)')
    .option('--root <path>', 'subdirectory that is the origin root')
    .option(
      '--layout <kind=glob>',
      "layout descriptor instead of auto-detection, e.g. skills='skills/.curated/*' (repeatable; kinds: skills, agents, commands, instructions, hooks, mcp, exclude, include; or nameFrom=dirname)",
      collect,
    )
    .option(
      '--project',
      'save the origin in this project’s palm.yaml instead of the global config',
    );
}

function installOptions(cmd: Command): void {
  cmd
    .option('--from <origin>', 'take the entities from this origin spec without registering it')
    .option('--save-origin', 'register the --from origin')
    .option('--secrets <policy>', 'MCP secrets: env-ref (project default) or literal (-g default)')
    .option('--prune', 'no names only: remove installed entries no longer in palm.yaml')
    .option(
      '--frozen',
      'no names only: install exactly what palm.lock.yaml records; fail on any difference, write nothing',
    );
  cmd.optionsGroup('Ad hoc MCP server options:');
  cmd
    .option('--url <url>', 'HTTP/SSE endpoint')
    .option('--header <K=V>', 'HTTP header (repeatable)', collect)
    .option('--env <K=V>', 'environment variable (repeatable)', collect)
    .option('--transport <t>', 'stdio, http or sse');
  cmd.optionsGroup('Origin options (install origin):');
  originOptions(cmd);
}

function registerVerb(program: Command, spec: VerbSpec, dispatch: Dispatch): void {
  const cmd = program
    .command(spec.name)
    .aliases([...spec.aliases])
    .summary(spec.summary)
    .description(`${spec.summary[0]?.toUpperCase()}${spec.summary.slice(1)}.`)
    .argument('[kind]', kindArgHelp(spec))
    .argument('[names...]', spec.name === 'search' ? 'words to look for' : 'name[@origin][#ref]');
  VERB_OPTIONS[spec.name]?.(cmd);
  cmd.addHelpText('after', VERB_HELP[spec.name]);
  cmd.action((kind: string | undefined, names: string[], _o: unknown, c: Command) =>
    dispatch(invocation(spec.name, [kind, ...names], c)),
  );
}

/** Commander calls actions with (...arguments, options, command): the arguments as names. */
function actionArgs(args: unknown[]): { names: string[]; opts: Record<string, unknown> } {
  const cmd = args[args.length - 1] as Command;
  const names = args
    .slice(0, -2)
    .flat()
    .filter((a): a is string => typeof a === 'string');
  return { names, opts: cmd.optsWithGlobals() };
}

function utility(command: string, dispatch: Dispatch): (...args: unknown[]) => Promise<void> {
  return (...args: unknown[]) => dispatch({ command, ...actionArgs(args) });
}

function registerConfig(program: Command, dispatch: Dispatch): void {
  const config = program
    .command('config')
    .summary('read or change global settings')
    .description(
      'Read or change palm’s global config: targets, mcpRegistryUrl, secrets.project, secrets.global.',
    )
    .addHelpText('after', CONFIG_HELP);
  const get = config
    .command('get')
    .description('Print one config value, or all of them.')
    .argument('[key]');
  get.action(utility('config get', dispatch));
  const set = config
    .command('set')
    .description('Set a config value (an empty value unsets it).')
    .argument('<key>')
    .argument('<value>', 'targets: comma list; secrets.*: env-ref | literal; mcpRegistryUrl: URL');
  set.action(utility('config set', dispatch));
}

function registerCache(program: Command, dispatch: Dispatch): void {
  const cache = program
    .command('cache')
    .summary('show or clear the origin cache')
    .description('Show or clear palm’s cache of origin checkouts and indexes.')
    .addHelpText('after', CACHE_HELP);
  const info = cache.command('info').description('Cache path, size, checkouts and index files.');
  info.action(utility('cache info', dispatch));
  const clean = cache
    .command('clean')
    .description('Remove every checkout and index (origins stay registered; next use refetches).');
  clean.action(utility('cache clean', dispatch));
}

const KIND_WORDS =
  'skill, agent, instruction, command, hook, mcp, plugin (plurals and short names work)';

/** `outdated`, `why`, `find` and `audit`: questions about what is installed. */
function registerInspection(program: Command, dispatch: Dispatch): void {
  program
    .command('outdated')
    .summary('show current, wanted and latest refs')
    .description(
      'Show, for each direct install, the locked ref, the ref palm.yaml wants now and the latest release.',
    )
    .argument('[kind]', `${KIND_WORDS}; omit it for every kind`)
    .addHelpText('after', OUTDATED_HELP)
    .action(utility('outdated', dispatch));
  program
    .command('why')
    .summary('show why an entity is installed')
    .description(
      'Show why an entity is installed: palm.yaml, or the plugin or agent that pulled it in, and what still needs it.',
    )
    .argument('<kind>', KIND_WORDS)
    .argument('<name>', 'name[@origin]')
    .addHelpText('after', WHY_HELP)
    .action(utility('why', dispatch));
  program
    .command('find')
    .summary('show which entity wrote a file')
    .description('Show which installed entity wrote a file (or merged a fragment into it).')
    .argument('<path>', 'file or directory palm wrote')
    .addHelpText('after', FIND_HELP)
    .action(utility('find', dispatch));
  program
    .command('audit')
    .summary('scan installed files for hidden Unicode')
    .description(
      'Scan the files palm installed for hidden Unicode (bidi overrides, tag characters, zero-width characters) and for changes since install.',
    )
    .argument('[kind]', `${KIND_WORDS}; omit it for every kind`)
    .argument('[names...]', 'only these entities')
    .option('--strip', 'remove the hidden characters from the files')
    .addHelpText('after', AUDIT_HELP)
    .action(utility('audit', dispatch));
}

function registerUtilities(program: Command, dispatch: Dispatch): void {
  const init = program
    .command('init')
    .summary('create palm.yaml for this project')
    .description('Choose the targets for this project, write them to palm.yaml and ignore .palm/.')
    .addHelpText('after', INIT_HELP);
  init.action(utility('init', dispatch));
  const doctor = program
    .command('doctor')
    .summary('check git, node, harnesses, drift, origins')
    .description(
      'Check git and Node, palm home, harness detection, lock/manifest drift and origin reachability (skipped with --offline).',
    )
    .addHelpText('after', DOCTOR_HELP);
  doctor.action(utility('doctor', dispatch));
  registerInspection(program, dispatch);
  registerConfig(program, dispatch);
  const completion = program
    .command('completion')
    .summary('print a shell completion script')
    .description(
      'Print a completion script for bash, zsh or fish, generated from this command tree.',
    )
    .argument('<shell>', 'bash, zsh or fish')
    .addHelpText('after', COMPLETION_HELP);
  completion.action(utility('completion', dispatch));
  registerCache(program, dispatch);
}

/** The old `palm origin …` group and `palm targets`, forwarding to the new verbs. */
function registerHiddenAliases(program: Command, dispatch: Dispatch): void {
  const origin = program
    .command('origin', { hidden: true })
    .description('Old form of palm install|get|uninstall|update origin.');
  const forward =
    (command: Verb, extra: Partial<Invocation> = {}) =>
    (...args: unknown[]) =>
      dispatch({ command, resource: 'origin', ...actionArgs(args), ...extra });
  originOptions(origin.command('add').argument('<spec>')).action(forward('install'));
  origin.command('list').alias('ls').action(forward('get'));
  origin.command('remove').alias('rm').argument('<alias>').action(forward('uninstall'));
  origin.command('update').argument('[aliases...]').action(forward('update'));
  origin
    .command('import')
    .argument('<source>')
    .option('--project', 'save in this project’s palm.yaml instead of the global config')
    .action(forward('install', { marketplace: true }));
  program
    .command('targets', { hidden: true })
    .action((_o: unknown, c: Command) =>
      dispatch({ command: 'get', resource: 'target', names: [], opts: c.optsWithGlobals() }),
    );
}

/** The full `palm` command tree. */
export function buildProgram(opts: ProgramOptions): Command {
  const program = createRootProgram(opts);
  program.commandsGroup('Verbs:');
  for (const spec of VERBS) registerVerb(program, spec, opts.dispatch);
  program.commandsGroup('Utilities:');
  registerUtilities(program, opts.dispatch);
  program.helpCommand('help [command]', 'show help for a verb or utility');
  registerHiddenAliases(program, opts.dispatch);
  program.addHelpText('after', ROOT_HELP);
  return program;
}

/**
 * Parse a full user argv (e.g. `['i', 'agent', 'x', '-g']`) exactly as the CLI would and
 * return the Invocation, without running anything. Grammar errors throw as they would.
 */
export function parseArgv(argv: string[]): { invocation: Invocation; passthrough: string[] } {
  const { args, passthrough } = splitPassthrough(argv);
  let invocation: Invocation | undefined;
  const program = buildProgram({
    dispatch: async (inv) => {
      invocation = inv;
    },
    writeOut: () => {},
    writeErr: () => {},
  });
  program.parse(args, { from: 'user' });
  if (!invocation) throw usage(`not a palm command: ${argv.join(' ')}`);
  return { invocation, passthrough };
}
