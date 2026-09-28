/**
 * Help text shown after each command's generated help: real examples in the
 * `palm <verb> [kind] [names...]` grammar. Plain strings only (loaded by `palm --help`).
 */
import type { Verb } from './grammar.js';

const DEP_GRAMMAR = `
Names: name[@origin][#ref]
  name       entity name (skill directory, agent file, MCP server key, plugin name)
  @origin    origin alias from \`palm get origins\` (needed when several origins have the name)
  #ref       tag, branch or commit of that origin (default: its latest semver tag)
  MCP registry servers go by their registry name: palm install mcp io.github.upstash/context7`;

const ORIGIN_FORMS = `
Origins: palm install origin <spec> [--alias a] [--ref r] [--root dir] [--layout kind=glob]
  <spec>     owner/repo, owner/repo/sub/dir, github:owner/repo, git URL[#ref], local path,
             or a marketplace.json (path or URL) whose plugins become origins
  The origin is fetched and indexed first; nothing is saved when that fails.`;

const ADHOC_FORMS = `
Ad hoc MCP servers (no origin needed):
  palm install mcp <name> [--env K=V]... -- <command> [args...]
  palm install mcp <name> --url <url> [--header K=V]... [--transport http|sse]
  \${VAR} in values stays an environment reference (env-ref) or is filled in (literal).`;

export const VERB_HELP: Readonly<Record<Verb, string>> = {
  install: `${DEP_GRAMMAR}
${ORIGIN_FORMS}
${ADHOC_FORMS}

Examples:
  palm install origin mattpocock/skills          register an origin
  palm install skill tdd@mattpocock              one skill from one origin
  palm install skills grill-me wayfinder         several of one kind
  palm install plugin superpowers -g             into your home directory
  palm install mcp fs -- npx -y @modelcontextprotocol/server-filesystem .
  palm install mcp docs --url https://example.com/mcp --header "Authorization=Bearer \${DOCS_TOKEN}"
  palm install                                   everything palm.yaml lists`,

  uninstall: `
Files you changed since palm wrote them stay on disk (listed); --force removes them too.

Examples:
  palm uninstall skill tdd                  remove a skill and what nothing else needs
  palm uninstall skills tdd wayfinder       several of one kind
  palm rm plugin superpowers -g             from the global scope
  palm uninstall skill tdd --force          also delete files you edited
  palm uninstall origin pstack              unregister an origin (installed entities stay)`,

  get: `
Examples:
  palm get                                  everything installed in this project
  palm get skills                           installed skills
  palm get sk --available -o mattpocock     what one origin offers
  palm get origins                          registered origins and what they hold
  palm get targets                          the harnesses palm writes to, and why
  palm get all -g                           installed entities, origins and targets`,

  describe: `
Examples:
  palm describe skill tdd                   origin, version, dependencies, files per harness
  palm describe agent comment-sicko@pstack
  palm describe origin mattpocock           url, ref, sha, layout, counts, cache path
  palm describe target claude -g            where each kind goes at the global scope`,

  update: `
Prints the plan first (~ updated, + added, - removed, = unchanged, x failed, and files you
changed that an update would overwrite), then asks before applying (default No). Without a
terminal, --yes is required.

Examples:
  palm update                               everything installed in this project
  palm update skills                        every directly installed skill
  palm update skill tdd --dry-run           show the plan only
  palm update --yes                         apply without asking (scripts, CI)
  palm update origins                       refetch and rescan every origin
  palm update origin mattpocock             one origin`,

  create: `
Examples:
  palm create skill release-notes
  palm create agent code-reviewer -g
  palm create instruction ts-style --no-install
  palm new command changelog`,

  search: `
Examples:
  palm search tdd
  palm search skill review                  skills only
  palm search mcp github                    MCP servers, the MCP registry included
  palm search refactor -o mattpocock        one origin`,
};

export const ROOT_HELP = `
Kinds: skill (sk), agent (ag), instruction (ins), command (cmd), hook (hk), mcp, plugin (pl),
       origin (orig), target (tg), all. Plurals work too: palm get skills.

Examples:
  palm install origin mattpocock/skills
  palm get skills --available
  palm install skill tdd@mattpocock
  palm describe skill tdd
  palm uninstall skill tdd

Run palm <verb> --help for the forms each verb accepts.
Exit codes: 0 ok, 1 failure, 2 usage error, 130 cancelled, 70 internal error.`;

export const COMPLETION_HELP = `
Install:
  bash   echo 'source <(palm completion bash)' >> ~/.bashrc
  zsh    echo 'source <(palm completion zsh)' >> ~/.zshrc     (after compinit)
  fish   palm completion fish > ~/.config/fish/completions/palm.fish

Examples:
  palm completion bash
  palm completion zsh > "\${fpath[1]}/_palm"`;

export const CACHE_HELP = `
Examples:
  palm cache info                           where the cache is and how big
  palm cache clean --yes                    remove checkouts and indexes (origins stay)`;

export const CONFIG_HELP = `
Examples:
  palm config get
  palm config set targets claude,codex
  palm config set secrets.project literal`;

export const INIT_HELP = `
Examples:
  palm init
  palm init --target claude,codex`;

export const OUTDATED_HELP = `
Columns:
  current    the ref palm.lock.yaml records
  wanted     what palm.yaml's #ref resolves to now: a tag, a branch head, or the newest tag
             in a semver range (#^1.2, #~1.2); no #ref: the latest release
  latest     the newest release tag, else the default branch head
Reads remote refs only (git ls-remote); the cache is never taken as current.

Examples:
  palm outdated                             every direct install in this project
  palm outdated skills                      skills only
  palm outdated -g --json                   global installs, as JSON`;

export const WHY_HELP = `
Examples:
  palm why skill brainstorm                 the plugin or agent that pulled it in
  palm why skill tdd@mattpocock             one origin's copy
  palm why mcp docs -g --json               in the global scope, as JSON`;

export const FIND_HELP = `
The path may be absolute, ~/…, or relative to this directory or the scope root. Without -g
the project and the global lockfile are searched. Exit 1 when no entity wrote the path.

Examples:
  palm find .claude/skills/tdd/SKILL.md     the entity that wrote it
  palm find .mcp.json                       merged config: every entity with a fragment in it
  palm find ~/.codex/AGENTS.md -g --json    global scope only, as JSON`;

export const AUDIT_HELP = `
Without -g the project and the global scope are scanned. Exit 1 while a critical finding
(bidi override, tag character) remains.

Examples:
  palm audit                                scan what palm installed for hidden Unicode
  palm audit skills tdd                     one skill
  palm audit --strip                        remove the hidden characters it finds
  palm audit -g --json                      the global scope only, as JSON`;

export const DOCTOR_HELP = `
Examples:
  palm doctor
  palm doctor --offline --json`;
