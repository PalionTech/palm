/**
 * The `palm` command tree: the eight verbs, then the utilities, then the hidden palm 0.1
 * commands that name their replacement. Registration only: every action turns its words into an
 * `Invocation` and hands it to `dispatch`, which imports the command module on demand, so
 * `palm --help` loads commander and picocolors and nothing else.
 */
import { Command, Help, Option } from 'commander';
import {
  applyPassthrough,
  type Dispatch,
  type Invocation,
  interpretInstall,
  interpretRemove,
  interpretWords,
  prepareArgv,
  usage,
  VERBS,
  type Verb,
  type VerbSpec,
} from './grammar.js';
import {
  CACHE_HELP,
  COMPLETION_HELP,
  MIGRATE_HELP,
  ROOT_DESCRIPTION,
  ROOT_HELP,
  VERB_HELP,
} from './help.js';
import { parseResource } from './ports.js';

export interface ProgramOptions {
  version?: string;
  dispatch: Dispatch;
  /** Where commander writes help (default: process.stdout). Errors are printed by runCli. */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

type Opts = Record<string, unknown>;

/** Collect a repeatable option into an array. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

const VERB_NAMES = new Set<string>(VERBS.map((v) => v.name));

/** `install (add, i)` for verbs; utilities keep their arguments (`completion <shell>`). */
function subcommandTerm(cmd: Command): string {
  const aliases = cmd.aliases();
  const name = aliases.length ? `${cmd.name()} (${aliases.join(', ')})` : cmd.name();
  if (VERB_NAMES.has(cmd.name()) && !cmd.parent?.parent) return name;
  if (cmd.commands.length) return `${name} ${cmd.commands.map((c) => c.name()).join('|')}`;
  const args = cmd.registeredArguments
    .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
    .join(' ');
  return args ? `${name} ${args}` : name;
}

/** Root help lists the verbs and utilities first and the options after them. */
function formatHelp(this: Help, cmd: Command, helper: Help): string {
  const text = Help.prototype.formatHelp.call(this, cmd, helper);
  if (cmd.parent) return text;
  const blocks = text.trimEnd().split('\n\n');
  const i = blocks.findIndex((b) => b.startsWith('Options:'));
  if (i < 0) return text;
  const options = blocks.splice(i, 1);
  return `${[...blocks, ...options].join('\n\n')}\n`;
}

/** The root command with the global flags (DESIGN.md §10), before any subcommand is added. */
function createRootProgram(opts: Omit<ProgramOptions, 'dispatch'>): Command {
  const program = new Command('palm')
    .exitOverride()
    .usage('<verb> [arguments] [options]')
    .description(ROOT_DESCRIPTION)
    .option('-g, --global', 'use ~/.palm/palm.yaml and the harness home directories')
    .option('--dry-run', 'show what would change; write nothing')
    .option('--force', 'replace files you changed or that palm does not own')
    .option('-y, --yes', 'accept plan confirmations (never consents to programs)')
    .option('--allow-exec <list>', 'allow programs: hook:name@source=sha256:hash,... or all')
    .option('--offline', 'use the cache only; no network')
    .option('--json', 'one JSON document on stdout; everything else on stderr')
    .option('--secrets <policy>', 'env-ref (default) or literal, for secrets you type')
    .addOption(new Option('--local', 'record in palm.local.yaml (palm 0.3)').hideHelp())
    .configureHelp({ showGlobalOptions: true, sortSubcommands: false, subcommandTerm, formatHelp })
    .showSuggestionAfterError(true)
    .configureOutput({
      ...(opts.writeOut ? { writeOut: opts.writeOut } : {}),
      ...(opts.writeErr ? { writeErr: opts.writeErr } : {}),
      outputError: () => undefined,
    });
  if (opts.version) program.version(opts.version, '-V, --version', 'print the palm version');
  return program;
}

/** Commander calls actions with (...arguments, options, command): the arguments as words. */
function actionWords(args: unknown[]): { words: string[]; opts: Opts } {
  const cmd = args[args.length - 1] as Command;
  const words = args
    .slice(0, -2)
    .flat()
    .filter((a): a is string => typeof a === 'string');
  return { words, opts: cmd.optsWithGlobals() };
}

function withLegacy(inv: Invocation, legacy: Invocation['legacy']): Invocation {
  return legacy ? { ...inv, legacy } : inv;
}

function installInvocation(words: string[], opts: Opts): Invocation {
  const w = interpretInstall(words);
  const command = w.mcp ? 'install mcp' : 'install';
  return withLegacy({ command, source: w.source, names: w.names, opts, words }, w.legacy);
}

function removeInvocation(words: string[], opts: Opts): Invocation {
  const w = interpretRemove(words);
  return withLegacy({ command: 'remove', source: w.source, names: w.names, opts, words }, w.legacy);
}

function wordsInvocation(verb: 'get' | 'describe') {
  return (words: string[], opts: Opts): Invocation => {
    const w = interpretWords(verb, words);
    return withLegacy(
      { command: verb, resource: w.resource, names: w.names, opts, words },
      w.legacy,
    );
  };
}

function createInvocation(words: string[], opts: Opts): Invocation {
  const [kind = '', name] = words;
  const resource = parseResource(kind);
  if (!resource)
    throw usage(
      `palm create makes a skill, agent, instruction or hook, not "${kind}"`,
      'palm create skill release-notes',
    );
  return { command: 'create', resource, names: name ? [{ name }] : [], opts, words };
}

const rawNames = (words: string[]) => words.map((name) => ({ name }));

interface VerbSetup {
  args: Array<[string, string]>;
  options?: (cmd: Command) => void;
  invocation: (words: string[], opts: Opts) => Invocation;
}

function installOptions(cmd: Command): void {
  cmd
    .option('--all', 'everything the source offers')
    .option('--as <name>', 'the name a URL source gets in palm.yaml')
    .option('--targets <ids>', 'only these targets for these entries (recorded per entry)')
    .option('--at <dir>', 'placement directory for these entries (recorded; honoured in 0.3)');
  cmd.optionsGroup('MCP servers (palm install mcp):');
  cmd
    .option('--url <url>', 'a remote server')
    .option('--header <K=V>', 'an HTTP header (repeatable)', collect)
    .option('--command <cmd>', 'a local (stdio) server: the program')
    .option('--arg <arg>', 'an argument for --command (repeatable)', collect)
    .option('--env <K=V>', 'an environment variable (repeatable)', collect)
    .option('--transport <t>', 'stdio, http or sse, when palm cannot tell')
    .option('--cwd <dir>', 'working directory for --command')
    .addOption(
      new Option('--mcp-json <file>', 'the snippet (spelled --json <file or ->)').hideHelp(),
    );
}

const VERB_SETUP: Readonly<Record<Verb, VerbSetup>> = {
  init: {
    args: [],
    options: (c) =>
      c
        .option(
          '--target <ids>',
          'comma-separated: claude, codex, copilot, cursor, gemini, opencode',
        )
        .option('--here', 'start a separate project in this directory'),
    invocation: (_w, opts) => ({ command: 'init', names: [], opts }),
  },
  install: {
    args: [
      ['[source]', 'owner/repo, a git URL, a directory, or a source in palm.yaml'],
      ['[names...]', '[kind:]name of what to install'],
    ],
    options: installOptions,
    invocation: installInvocation,
  },
  remove: {
    args: [['<names...>', 'an optional source, then [kind:]name of what to remove']],
    options: (c) => c.option('--exclude', 'a plugin member: exclude it for the team in palm.yaml'),
    invocation: removeInvocation,
  },
  update: {
    args: [['[sources...]', 'sources to update (default: all)']],
    options: (c) =>
      c
        .option('--to <ref>', 'move the ref in palm.yaml (a tag, branch, sha or range such as ^2)')
        .option('--review', 'print changed scripts and entities as diffs before asking')
        .option('--strict', 'with --dry-run: exit 1 when a source is behind its ref'),
    invocation: (words, opts) => ({ command: 'update', names: rawNames(words), opts, words }),
  },
  check: { args: [], invocation: (_w, opts) => ({ command: 'check', names: [], opts }) },
  get: {
    args: [
      ['[kind]', 'skill, agent, instruction, hook, mcp, plugin; source, target or all'],
      ['[names...]', 'only these names'],
    ],
    options: (c) =>
      c
        .option('-s, --source <source>', 'only what came from this source')
        .option('--files', 'every file palm wrote, with its entry'),
    invocation: wordsInvocation('get'),
  },
  describe: {
    args: [['<what...>', '[kind:]name, a path, source <name> or target <id>']],
    options: (c) => c.option('-s, --source <source>', 'the entity from this source'),
    invocation: wordsInvocation('describe'),
  },
  create: {
    args: [
      ['<kind>', 'skill, agent, instruction or hook'],
      ['<name>', 'the new entity'],
    ],
    options: (c) =>
      c
        .option('--in <dir>', 'the source directory (default ./agent-kit; ~/.palm/kit with -g)')
        .option('--description <text>', 'the description in the template'),
    invocation: createInvocation,
  },
};

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function registerVerb(program: Command, spec: VerbSpec, dispatch: Dispatch): void {
  const setup = VERB_SETUP[spec.name];
  const cmd = program
    .command(spec.name)
    .aliases([...spec.aliases])
    .summary(spec.summary)
    .description(capitalised(spec.summary))
    .usage(`${spec.arguments} [options]`.trim())
    .addHelpText('after', VERB_HELP[spec.name]);
  for (const [name, description] of setup.args) cmd.argument(name, description);
  setup.options?.(cmd);
  cmd.action((...args: unknown[]) => {
    const { words, opts } = actionWords(args);
    return dispatch(setup.invocation(words, opts));
  });
}

function utility(command: string, dispatch: Dispatch) {
  return (...args: unknown[]) => {
    const { words, opts } = actionWords(args);
    return dispatch({ command, names: rawNames(words), opts, words });
  };
}

function registerUtilities(program: Command, dispatch: Dispatch): void {
  program
    .command('migrate')
    .summary('convert a palm 0.1 project to the palm 0.2 files')
    .description('Convert palm 0.1 files (palm.yaml, palm.lock.yaml, ~/.palm/config.yaml).')
    .addHelpText('after', MIGRATE_HELP)
    .action(utility('migrate', dispatch));
  program
    .command('completion')
    .summary('print a shell completion script')
    .description('Print a completion script for bash, zsh or fish.')
    .argument('<shell>', 'bash, zsh or fish')
    .addHelpText('after', COMPLETION_HELP)
    .action(utility('completion', dispatch));
  const cache = program
    .command('cache')
    .summary('delete the cache of checkouts and indexes')
    .description('Manage the cache under ~/.palm/cache.');
  cache
    .command('clean')
    .description('Delete every checkout and index (sources stay declared).')
    .addHelpText('after', CACHE_HELP)
    .action(utility('cache clean', dispatch));
}

/** DESIGN.md §10: the palm 0.1 commands name their replacement and exit 2. */
const LEGACY_COMMANDS: Readonly<Record<string, (args: string[]) => string>> = {
  doctor: () => 'palm doctor is now: palm check',
  audit: () => 'palm audit is now: palm check',
  outdated: () => 'palm outdated is now: palm update --dry-run',
  why: (a) => `palm why is now: palm describe ${a.join(' ').replace(/@\S+/g, '') || '<name>'}`,
  find: (a) => `palm find is now: palm describe ${a[0] ?? '<path>'}`,
  search: (a) => {
    const q = encodeURIComponent(a.join(' ') || 'skills');
    const url = `https://github.com/search?q=${q}+SKILL.md&type=code`;
    return `palm search is gone; find a repository (${url}), then list it: palm install <owner/repo>`;
  },
  config: () => 'palm config is gone; targets live in palm.yaml (~/.palm/palm.yaml with -g)',
  origin: (a) => originReplacement(a),
};

function originReplacement([sub, spec]: string[]): string {
  const form = ['palm origin', sub].filter(Boolean).join(' ');
  if (sub === 'add' || sub === 'import')
    return `${form} is now: palm install ${spec ?? '<owner/repo>'}`;
  if (sub === 'update') return `${form} is now: palm update`;
  if (sub === 'remove' || sub === 'rm')
    return `${form} is gone; a source leaves palm.yaml with its last entry: palm get --source ${spec ?? '<name>'}`;
  return `${form} is now: palm get sources`;
}

function registerLegacy(program: Command): void {
  for (const [name, line] of Object.entries(LEGACY_COMMANDS)) {
    program
      .command(name, { hidden: true })
      .argument('[args...]')
      .allowUnknownOption()
      .helpOption(false)
      .action((args: string[]) => {
        throw usage(line(args));
      });
  }
}

/** The full `palm` command tree. */
export function buildProgram(opts: ProgramOptions): Command {
  const program = createRootProgram(opts);
  program.commandsGroup('Verbs:');
  for (const spec of VERBS) registerVerb(program, spec, opts.dispatch);
  program.commandsGroup('Utilities:');
  registerUtilities(program, opts.dispatch);
  program.helpCommand('help [command]', 'show help for a verb or utility');
  registerLegacy(program);
  program.addHelpText('after', ROOT_HELP);
  return program;
}

/**
 * Parse a full argv (`['i', 'mattpocock/skills', 'tdd', '-g']`) exactly as the CLI would and
 * return the Invocation, without running anything. Grammar errors throw as they would.
 */
export function parseArgv(argv: string[]): { invocation: Invocation; passthrough: string[] } {
  const { args, passthrough } = prepareArgv(argv);
  let invocation: Invocation | undefined;
  const program = buildProgram({
    dispatch: async (inv) => {
      invocation = applyPassthrough(inv, passthrough);
    },
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  program.parse(args, { from: 'user' });
  if (!invocation) throw usage(`not a palm command: ${argv.join(' ')}`, 'palm --help');
  return { invocation, passthrough };
}
