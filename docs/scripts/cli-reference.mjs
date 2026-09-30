#!/usr/bin/env node
// Generates the CLI reference from the CLI itself, so no option table can drift from palm.
//
//   node scripts/cli-reference.mjs           write the help captures, the JSON and the page tables
//   node scripts/cli-reference.mjs --check   exit 1 when any of them is stale, a command has no page,
//                                            or a `palm …` line in the reference does not parse
//   node scripts/cli-reference.mjs --lint-all  also report `palm …` lines on every other docs page
//
// Build the CLI first (`npm run build` at the repository root). The script runs
// `node ../dist/cli.js --help`, `<command> --help` for every verb and utility the root help lists
// (and every subcommand their help lists), and `completion bash` for the kind words each command
// accepts. Everything runs in a throwaway home with colour off, like scripts/capture.mjs.
//
// Output:
//   src/captures/c-help.txt, c-help-<command>.txt, c-help-<command>-<sub>.txt
//       the raw help, in capture format (`<Capture name="c-help-install" />` renders one)
//   src/captures/c-cli-options.json
//       every command with its aliases, arguments, options and kind words
//   the table between `<!-- cli-reference:<block> -->` and `<!-- /cli-reference -->` in each
//   page under src/content/docs/reference (`{/* … */}` markers in .mdx pages). Blocks:
//       verbs, utilities, kinds, global-options      the CLI overview
//       options <command> [<sub>]                    arguments and options of one command
//       arguments <command> [<sub>]                  only the arguments of one command
//       subcommands <command>                        the subcommands of cache
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(DOCS, '..');
const CLI = join(REPO, 'dist', 'cli.js');
const CAPTURES = join(DOCS, 'src', 'captures');
const CONTENT = join(DOCS, 'src', 'content', 'docs');
const REFERENCE = join(CONTENT, 'reference');
const JSON_FILE = 'c-cli-options.json';
const PAGE_BASE = '/palm/reference/cli';
const GLOBAL_LINK = `[global options](${PAGE_BASE}/#global-options)`;
const ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'LANG'];

// ---------------------------------------------------------------------------
// Running palm
// ---------------------------------------------------------------------------

function makeSandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'palm-cli-reference-')));
  const home = join(root, 'home');
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const env = { HOME: home, PALM_HOME: join(home, '.palm') };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { NO_COLOR: '1', TERM: 'dumb', GIT_CONFIG_NOSYSTEM: '1' });
  return { root, project, env };
}

function palm(box, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: box.project,
    env: box.env,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`palm ${args.join(' ')} exited ${r.status}:\n${r.stderr}`);
  return r.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n');
}

// ---------------------------------------------------------------------------
// Parsing commander's help
// ---------------------------------------------------------------------------

/** Blocks of a help text; a block titled `Name:` on its own line holds items. */
function helpBlocks(text) {
  return text
    .trimEnd()
    .split(/\n{2,}/)
    .map((block) => block.split('\n'))
    .filter((lines) => lines.some((l) => l.trim() !== ''));
}

/** `  term      description` items; deeper-indented lines continue the previous description. */
function items(lines) {
  const out = [];
  const notes = [];
  for (const line of lines) {
    if (/^ {2}\S/.test(line)) {
      const m = /^ {2}(\S.*?)(?: {2,}(\S.*))?$/.exec(line);
      out.push({ term: m[1], description: m[2] ?? '' });
    } else if (/^ {3,}\S/.test(line) && out.length) {
      const last = out[out.length - 1];
      last.description = `${last.description} ${line.trim()}`.trim();
    } else if (line.trim()) notes.push(line.trim());
  }
  return { items: out, notes };
}

/** { usage, description, sections: { title: { items, notes } }, order: [title] } */
function parseHelp(text) {
  const blocks = helpBlocks(text);
  const help = { usage: '', description: '', sections: {}, order: [] };
  for (const lines of blocks) {
    const first = lines[0] ?? '';
    const usage = /^Usage: (.*)$/.exec(first);
    const titled = /^(\S[^:]*):$/.exec(first);
    if (usage) help.usage = usage[1];
    else if (titled) {
      help.sections[titled[1]] = items(lines.slice(1));
      help.order.push(titled[1]);
    } else if (!help.description && help.order.length === 0)
      help.description = lines.map((l) => l.trim()).join(' ');
    else help.order.push({ text: lines.join('\n') });
  }
  return help;
}

/** `-s, --source <name>` → flags, short, long, argument. */
function parseOption({ term, description }) {
  const m =
    /^(?:(-\w), )?(--[\w-]+)(?: ([<[].*[>\]]))?$/.exec(term) ?? /^(-\w)()(?: (.*))?$/.exec(term);
  if (!m) throw new Error(`cannot parse option "${term}"`);
  return {
    flags: term,
    short: m[1] || undefined,
    long: m[2] || undefined,
    argument: m[3] || undefined,
    description,
  };
}

/** `install (add, i)`, `describe (info) <name>`, `cache clean`. */
function parseCommandTerm(term) {
  const m = /^(\S+)(?: \(([^)]*)\))?(?: (.*))?$/.exec(term);
  return {
    name: m[1],
    aliases: m[2] ? m[2].split(',').map((a) => a.trim()) : [],
    args: m[3] ?? '',
  };
}

const HELP_FLAG = '-h, --help';

function optionGroups(help) {
  return help.order
    .filter((t) => typeof t === 'string' && /\boptions\b/i.test(t) && t !== 'Global Options')
    .map((title) => ({
      title,
      options: help.sections[title].items.map(parseOption),
    }));
}

function argumentsOf(help) {
  return (help.sections.Arguments?.items ?? []).map((i) => ({
    name: i.term,
    description: i.description,
  }));
}

/** `Kinds: skill (sk), agent (ag), …, all. Plurals work too…` in the root help. */
function parseKinds(text) {
  const m = /Kinds: ([\s\S]*?)\. Plurals/.exec(text);
  if (!m) throw new Error('root help has no "Kinds:" line');
  return m[1]
    .split(/,\s*/)
    .map((k) => /^(\S+)(?: \((\S+)\))?$/.exec(k.trim()))
    .map((k) => ({ name: k[1], short: k[2] }));
}

/** Per command of the bash completion script: its option list and the words it completes first. */
function parseCompletion(script) {
  const out = {};
  const re = /^ {4}([\w|-]+)\)\n\s+opts="([^"]*)"\n\s+words="([^"]*)"/gm;
  for (const m of script.matchAll(re)) {
    const [name] = m[1].split('|');
    out[name] = {
      options: m[2].split(/\s+/).filter(Boolean),
      words: m[3].split(/\s+/).filter(Boolean),
    };
  }
  return out;
}

/** Group the flat word list of `palm get` (every resource) by resource. */
function kindWords(kinds, getWords) {
  const names = new Set(kinds.map((k) => k.name));
  const byKind = new Map();
  let current;
  for (const w of getWords) {
    if (names.has(w)) current = w;
    if (!current) continue;
    byKind.set(current, [...(byKind.get(current) ?? []), w]);
  }
  return kinds.map((k) => ({ ...k, words: byKind.get(k.name) ?? [k.name] }));
}

// ---------------------------------------------------------------------------
// Collecting the CLI
// ---------------------------------------------------------------------------

function collect() {
  const box = makeSandbox();
  try {
    const captures = {};
    const rootText = palm(box, ['--help']);
    captures['c-help.txt'] = `$ palm --help\n${rootText.trimEnd()}\n`;
    const root = parseHelp(rootText);
    const completion = parseCompletion(palm(box, ['completion', 'bash']));
    const kinds = kindWords(parseKinds(rootText), completion.get?.words ?? []);
    const commands = [];
    for (const [group, title] of [
      ['verb', 'Verbs'],
      ['utility', 'Utilities'],
    ]) {
      for (const item of root.sections[title]?.items ?? []) {
        const term = parseCommandTerm(item.term);
        if (term.name === 'help') continue;
        const text = palm(box, [term.name, '--help']);
        captures[`c-help-${term.name}.txt`] = `$ palm ${term.name} --help\n${text.trimEnd()}\n`;
        const help = parseHelp(text);
        const subcommands = [];
        for (const sub of help.sections.Commands?.items ?? []) {
          const subTerm = parseCommandTerm(sub.term);
          if (subTerm.name === 'help') continue;
          const subText = palm(box, [term.name, subTerm.name, '--help']);
          captures[`c-help-${term.name}-${subTerm.name}.txt`] =
            `$ palm ${term.name} ${subTerm.name} --help\n${subText.trimEnd()}\n`;
          const subHelp = parseHelp(subText);
          subcommands.push({
            name: subTerm.name,
            args: subTerm.args,
            summary: sub.description,
            usage: subHelp.usage,
            description: subHelp.description,
            arguments: argumentsOf(subHelp),
            optionGroups: optionGroups(subHelp),
          });
        }
        commands.push({
          name: term.name,
          group,
          aliases: term.aliases,
          args: term.args,
          summary: item.description,
          usage: help.usage,
          description: help.description,
          arguments: argumentsOf(help),
          optionGroups: optionGroups(help),
          kindWords: subcommands.length ? [] : (completion[term.name]?.words ?? []),
          subcommands,
        });
      }
    }
    const data = {
      usage: root.usage,
      globalOptions: (root.sections.Options?.items ?? []).map(parseOption),
      kinds,
      commands,
    };
    return { data, captures };
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Rendering tables
// ---------------------------------------------------------------------------

/** Help text as Markdown table text, verbatim: one word as code, else table and HTML characters escaped. */
function cell(text) {
  if (/^\S+$/.test(text) && !text.includes('`')) return code(text.replace(/\|/g, '\\|'));
  const t = text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\*/g, '\\*');
  return t.replace(/_/g, '\\_').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(text) {
  return `\`${text}\``;
}

function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function optionRows(options) {
  return options
    .filter((o) => o.flags !== HELP_FLAG)
    .map((o) => [code(o.flags), cell(o.description)]);
}

function commandPath(data, words) {
  const cmd = data.commands.find((c) => c.name === words[0]);
  if (!cmd) return undefined;
  if (words.length === 1) return cmd;
  return cmd.subcommands.find((s) => s.name === words[1]);
}

function renderArguments(cmd) {
  return table(
    ['Argument', 'Meaning'],
    cmd.arguments.map((a) => [code(a.name), a.description ? cell(a.description) : '']),
  );
}

function renderOptions(data, words) {
  const cmd = commandPath(data, words);
  if (!cmd) throw new Error(`no command "${words.join(' ')}"`);
  const parts = [];
  if (cmd.arguments.length) parts.push(renderArguments(cmd));
  const [main, ...groups] = cmd.optionGroups;
  const own = optionRows(main?.options ?? []);
  if (own.length) parts.push(table(['Option', 'Meaning'], own));
  for (const g of groups)
    parts.push(`### ${g.title}`, table(['Option', 'Meaning'], optionRows(g.options)));
  const hasOwn = own.length > 0 || groups.length > 0;
  parts.push(
    hasOwn ? `The ${GLOBAL_LINK} also apply.` : `No options of its own. The ${GLOBAL_LINK} apply.`,
  );
  return parts.join('\n\n');
}

function renderSubcommands(data, name) {
  const cmd = commandPath(data, [name]);
  if (!cmd?.subcommands.length) throw new Error(`"${name}" has no subcommands`);
  return table(
    ['Command', 'Meaning'],
    cmd.subcommands.map((s) => [
      code(`palm ${name} ${s.name}${s.args ? ` ${s.args}` : ''}`),
      cell(s.summary),
    ]),
  );
}

function renderCommands(data, group) {
  const rows = data.commands
    .filter((c) => c.group === group)
    .map((c) => {
      const link = `[${code(c.name)}](${PAGE_BASE}/${c.name}/)`;
      const aliases = c.aliases.map(code).join(', ');
      return group === 'verb'
        ? [link, aliases, cell(c.summary)]
        : [link, c.args ? code(c.args) : '', cell(c.summary)];
    });
  const header =
    group === 'verb' ? ['Verb', 'Aliases', 'Meaning'] : ['Utility', 'Arguments', 'Meaning'];
  return table(header, rows);
}

function renderKinds(data) {
  const verbs = data.commands.filter((c) => c.group === 'verb');
  return table(
    ['Kind', 'Short name', 'Other words', 'Verbs'],
    data.kinds.map((k) => {
      const other = k.words.filter((w) => w !== k.name && w !== k.short);
      const taking = verbs.filter((v) => v.kindWords.includes(k.name)).map((v) => code(v.name));
      return [
        code(k.name),
        k.short && k.short !== k.name ? code(k.short) : '',
        other.map(code).join(', '),
        taking.join(', '),
      ];
    }),
  );
}

function renderGlobalOptions(data) {
  return table(
    ['Option', 'Meaning'],
    data.globalOptions.map((o) => [code(o.flags), cell(o.description)]),
  );
}

function renderBlock(data, id) {
  const [kind, ...words] = id.split(/\s+/);
  switch (kind) {
    case 'verbs':
      return renderCommands(data, 'verb');
    case 'utilities':
      return renderCommands(data, 'utility');
    case 'kinds':
      return renderKinds(data);
    case 'global-options':
      return renderGlobalOptions(data);
    case 'options':
      return renderOptions(data, words);
    case 'arguments': {
      const cmd = commandPath(data, words);
      if (!cmd?.arguments.length) throw new Error(`"${words.join(' ')}" has no arguments`);
      return renderArguments(cmd);
    }
    case 'subcommands':
      return renderSubcommands(data, words[0]);
    default:
      throw new Error(`unknown block "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function* pages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* pages(abs);
    else if (/\.mdx?$/.test(entry.name)) yield abs;
  }
}

/** Start and end markers for a page: HTML comments in .md, JSX comments in .mdx. */
function markers(file) {
  return file.endsWith('.mdx')
    ? { start: /^\{\/\* cli-reference:(.+?) \*\/\}$/, end: '{/* /cli-reference */}' }
    : { start: /^<!-- cli-reference:(.+?) -->$/, end: '<!-- /cli-reference -->' };
}

/** The page with every block regenerated, and the block ids it holds. */
function fillPage(data, file) {
  const text = readFileSync(file, 'utf8');
  const { start, end } = markers(file);
  const lines = text.split('\n');
  const out = [];
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    const m = start.exec(lines[i]);
    out.push(lines[i]);
    if (!m) continue;
    const close = lines.indexOf(end, i + 1);
    if (close < 0) throw new Error(`${relative(DOCS, file)}: block "${m[1]}" has no end marker`);
    ids.push(m[1]);
    out.push('', renderBlock(data, m[1]), '', end);
    i = close;
  }
  return { text: out.join('\n'), ids };
}

// ---------------------------------------------------------------------------
// Checking `palm …` lines
// ---------------------------------------------------------------------------

/** Shell-like words of a command line, up to a pipe, redirect, `;`, `&&` or comment. */
function shellWords(line) {
  const words = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (!cur && !has && (ch === '#' || ch === ';' || ch === '>' || ch === '&')) break;
    if (!cur && !has && ch === '|' && /[\s|]/.test(line[i + 1] ?? ' ')) break;
    cur += ch;
  }
  if (has || cur) words.push(cur);
  return words;
}

/** Notation, not a literal word: `<name>`, `[kind]`, `...`, `…`. */
function isPlaceholder(word) {
  return /^[<[]|\.\.\.|…/.test(word);
}

function lookupCommand(data, word) {
  return data.commands.find((c) => c.name === word || c.aliases.includes(word));
}

function optionTable(cmd, data) {
  const all = [...data.globalOptions, ...cmd.optionGroups.flatMap((g) => g.options)];
  const map = new Map();
  for (const o of all) {
    if (o.short) map.set(o.short, o);
    if (o.long) map.set(o.long, o);
  }
  return map;
}

/** Problems with one `palm …` command line, checked against the collected CLI. */
function checkLine(data, line) {
  const words = shellWords(line);
  if (words[0] !== 'palm') return [];
  const problems = [];
  let i = 1;
  const globals = optionTable({ optionGroups: [] }, data);
  while (words[i]?.startsWith('-')) {
    if (!globals.has(words[i].split('=')[0])) problems.push(`unknown option ${words[i]}`);
    i++;
  }
  const verb = words[i];
  if (verb === undefined || isPlaceholder(verb) || verb === 'help') return problems;
  let cmd = lookupCommand(data, verb);
  if (!cmd) return [...problems, `unknown command "${verb}"`];
  i++;
  if (cmd.subcommands.length && words[i] && !words[i].startsWith('-') && !isPlaceholder(words[i])) {
    const alternatives = words[i].split('|');
    const bad = alternatives.filter((w) => !cmd.subcommands.some((s) => s.name === w));
    if (bad.length) problems.push(`"palm ${cmd.name}" has no subcommand "${bad.join('|')}"`);
    if (alternatives.length === 1 && !bad.length) {
      const sub = cmd.subcommands.find((s) => s.name === alternatives[0]);
      cmd = { ...sub, kindWords: [], subcommands: [], name: `${cmd.name} ${sub.name}` };
    }
    i++;
  }
  const options = optionTable(cmd, data);
  const allKindWords = new Set(data.kinds.flatMap((k) => k.words));
  let positional = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') break;
    if (/^--?[\w-]/.test(w)) {
      const [flag] = w.split('=');
      const names = /^-\w{2,}$/.test(flag) ? [...flag.slice(1)].map((c) => `-${c}`) : [flag];
      for (const n of names) {
        const o = options.get(n);
        if (!o) problems.push(`"palm ${cmd.name}" has no option ${n}`);
        else if (o.argument && !w.includes('=') && names.length === 1) i++;
      }
      continue;
    }
    positional++;
    if (positional !== 1 || isPlaceholder(w) || !cmd.kindWords.length) continue;
    const alternatives = w.split('|');
    for (const a of alternatives)
      if (allKindWords.has(a) && !cmd.kindWords.includes(a))
        problems.push(`"palm ${cmd.name}" does not take "${a}"`);
  }
  return problems;
}

/** Every `palm …` line of a page: in shell code blocks, and in inline code. */
function palmLines(text) {
  const out = [];
  let fence;
  for (const [n, raw] of text.split('\n').entries()) {
    const f = /^\s*(```|~~~)(\w*)/.exec(raw);
    if (f) {
      fence = fence ? undefined : f[2] || 'text';
      continue;
    }
    if (fence) {
      if (/^(sh|bash|shell|zsh)$/.test(fence)) {
        const line = raw.trim().replace(/^\$ /, '');
        if (line.startsWith('palm ') || line === 'palm') out.push([n + 1, line]);
      }
      continue;
    }
    for (const m of raw.matchAll(/`(palm(?: [^`]*)?)`/g)) out.push([n + 1, m[1]]);
  }
  return out;
}

function lintPage(data, file) {
  const problems = [];
  for (const [n, line] of palmLines(readFileSync(file, 'utf8')))
    for (const p of checkLine(data, line))
      problems.push(`${relative(DOCS, file)}:${n}: ${p} in \`${line}\``);
  return problems;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Every command needs a page; every command page needs its options block. */
function coverage(data, idsByFile) {
  const problems = [];
  const siteMap = readFileSync(join(DOCS, 'src', 'site-map.mjs'), 'utf8');
  for (const c of data.commands) {
    const file = ['.md', '.mdx']
      .map((ext) => join(REFERENCE, 'cli', `${c.name}${ext}`))
      .find((f) => existsSync(f));
    if (!file) {
      problems.push(`no page for palm ${c.name}: add src/content/docs/reference/cli/${c.name}.md`);
      continue;
    }
    if (!new RegExp(`'${c.name}'`).test(siteMap))
      problems.push(`src/site-map.mjs does not list reference/cli/${c.name}`);
    if (!(idsByFile.get(file) ?? []).includes(`options ${c.name}`))
      problems.push(
        `${relative(DOCS, file)}: no options block (add <!-- cli-reference:options ${c.name} -->)`,
      );
  }
  for (const f of readdirSync(join(REFERENCE, 'cli'))) {
    const name = f.replace(/\.mdx?$/, '');
    if (!data.commands.some((c) => c.name === name))
      problems.push(`reference/cli/${f} documents "${name}", which palm --help does not list`);
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  if (!existsSync(CLI))
    throw new Error(`${CLI} not found: run npm run build at the repository root`);
  const { data, captures } = collect();
  const files = { ...captures, [JSON_FILE]: `${JSON.stringify(data, null, 2)}\n` };
  const stale = [];
  mkdirSync(CAPTURES, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = join(CAPTURES, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current === text) continue;
    if (check) stale.push(`src/captures/${name}`);
    else writeFileSync(path, text);
  }
  const idsByFile = new Map();
  for (const file of pages(REFERENCE)) {
    const { text, ids } = fillPage(data, file);
    idsByFile.set(file, ids);
    if (text === readFileSync(file, 'utf8')) continue;
    if (check) stale.push(relative(DOCS, file));
    else writeFileSync(file, text);
  }
  const problems = [...coverage(data, idsByFile)];
  for (const file of pages(REFERENCE)) problems.push(...lintPage(data, file));
  if (argv.includes('--lint-all')) {
    const others = [...pages(CONTENT)].filter((f) => !f.startsWith(REFERENCE));
    for (const file of others)
      for (const p of lintPage(data, file)) process.stdout.write(`note: ${p}\n`);
  }
  const verb = check ? 'checked' : 'wrote';
  process.stdout.write(
    `cli-reference: ${verb} ${Object.keys(files).length} captures and ${idsByFile.size} pages\n`,
  );
  if (stale.length)
    process.stderr.write(`stale (run npm run cli-reference):\n  ${stale.join('\n  ')}\n`);
  if (problems.length) process.stderr.write(`cli-reference:\n  ${problems.join('\n  ')}\n`);
  if (stale.length || problems.length) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  process.stderr.write(`cli-reference: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
