/**
 * Skip lists: the one home for what palm never scans, copies, hashes or puts in an asset
 * closure (DESIGN.md sections 2, 4 and 5).
 *
 * - scan (src/index): `SCAN_IGNORE_DIRS`, `INSTALL_OUTPUT_DIRS`, `ROOT_IGNORED_FILES`, `DOC_FILE_NAMES`
 * - copy (src/targets): `COPY_SKIP`
 * - hash (src/core/hash): `HASH_SKIP`, the same list as `COPY_SKIP`; a local source's tree: `isTreeExcluded`
 * - asset closure (src/index/references, src/targets/assets): `CLOSURE_NEVER`, `isClosureExcluded`
 * - relocation (src/index/references, src/targets/relocate): `PLUGIN_ROOT_TOKENS`, `PROJECT_DIR_TOKENS`
 *
 * Entries are entry names; `*.ext` matches a suffix and `prefix*` a prefix, ignoring case.
 */

/** Directories no walk ever enters: VCS metadata and dependency trees (scan, copy and hash). */
export const ALWAYS_SKIP_DIRS: readonly string[] = ['.git', 'node_modules'];

/** Scan: directory names skipped at any depth of an auto-detected scan. */
export const SCAN_IGNORE_DIRS: readonly string[] = [
  ...ALWAYS_SKIP_DIRS,
  'test',
  'tests',
  'fixture',
  'fixtures',
  'eval',
  'evals',
  'example',
  'examples',
  'template',
  'templates',
  'docs',
  'website',
  'dist',
  'build',
];

/**
 * Scan: harness install outputs committed to repos (palm or other installers wrote them), palm's
 * own directory and editor config. They mirror real sources elsewhere in the repo or configure
 * the repo's own development. Relative directory paths, matched at any depth.
 */
export const INSTALL_OUTPUT_DIRS: readonly string[] = [
  '.agents/skills',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.claude/rules',
  '.github/skills',
  '.github/agents',
  '.github/instructions',
  '.github/prompts',
  '.github/hooks',
  '.cursor/rules',
  '.cursor/agents',
  '.cursor/commands',
  '.codex/agents',
  '.codex/prompts',
  '.palm',
  '.vscode',
];

/** Scan: repository-level files (contributor guidance, dev config), matched at the source root only. */
export const ROOT_IGNORED_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json.example',
  '.cursor/mcp.json',
  '.cursor/hooks.json',
];

/** Scan: repository documents (lower case) that never count as entities, even inside `agents/`. */
export const DOC_FILE_NAMES: readonly string[] = [
  'readme.md',
  'changelog.md',
  'license.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'agents.md',
  'claude.md',
  'gemini.md',
];

/**
 * Copy: entry names never deployed, at any depth: VCS metadata (a `.git` directory, or the
 * `.git` file of a submodule), dependency trees, Finder litter and archives.
 */
export const COPY_SKIP: readonly string[] = [...ALWAYS_SKIP_DIRS, '.DS_Store', '*.zip'];

/** Hash: the same list as `COPY_SKIP`, so a content hash covers exactly the files a copy deploys. */
export const HASH_SKIP: readonly string[] = [...COPY_SKIP];

/**
 * Asset closure: entry names never copied to `.palm/assets`, at any depth, so a harness that
 * scans downward finds no skill, root document or manifest there (DESIGN.md section 2).
 */
export const CLOSURE_NEVER: readonly string[] = [
  'SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'marketplace.json',
  'plugin.json',
  '*-plugin',
  '.git*',
  'node_modules',
];

/**
 * A reference to the plugin root in a hook or MCP command: `${CLAUDE_PLUGIN_ROOT}`,
 * `${CLAUDE_PLUGIN_ROOT:-x}`, `${CLAUDE_PLUGIN_ROOT-x}`, `$CLAUDE_PLUGIN_ROOT`,
 * `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` and `${extensionPath}` (global flag: use with
 * `matchAll`, `replace` or `match`, never `test`).
 */
export const PLUGIN_ROOT_TOKENS =
  /\$\{(?:CLAUDE_PLUGIN_ROOT(?::?-[^}]*)?|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath)\}|\$CLAUDE_PLUGIN_ROOT\b/g;

/**
 * A reference to the project directory a harness exports: `$CLAUDE_PROJECT_DIR`,
 * `${CLAUDE_PROJECT_DIR}`, `$CURSOR_PROJECT_DIR`, `$GEMINI_PROJECT_DIR` (and their braced
 * forms). Global flag, as PLUGIN_ROOT_TOKENS.
 */
export const PROJECT_DIR_TOKENS =
  /\$\{(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}|\$(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\b/g;

/** True when `pattern` (`name`, `*.ext` or `prefix*`) matches `name`, ignoring case. */
function matchesPattern(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p.startsWith('*')) return n.endsWith(p.slice(1));
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1));
  return p === n;
}

/** True when `name` is in `list`, or matches one of its `*.ext` / `prefix*` entries (any case). */
export function matchesSkip(list: readonly string[], name: string): boolean {
  return list.some((p) => (p.includes('*') ? matchesPattern(p, name) : p === name));
}

/** Scan: true for a directory name an auto-detected scan never enters (`SCAN_IGNORE_DIRS`). */
export function shouldSkipDir(name: string): boolean {
  return SCAN_IGNORE_DIRS.includes(name);
}

/**
 * Copy and hash: true for an entry name that is never copied or hashed (`COPY_SKIP`). Decided on
 * the name before the entry is examined, so it also covers the `.git` and `node_modules`
 * directories and links with those names.
 */
export function shouldSkipFile(name: string): boolean {
  return matchesSkip(COPY_SKIP, name);
}

/** Scan: true for a repository document that is never an entity (`DOC_FILE_NAMES`, any case). */
export function isDocFile(fileName: string): boolean {
  return DOC_FILE_NAMES.includes(fileName.toLowerCase());
}

/** True when `rel` (posix, relative) lies in or below one of INSTALL_OUTPUT_DIRS, at any depth. */
function isUnderInstallOutput(rel: string): boolean {
  const padded = `/${rel}/`;
  return INSTALL_OUTPUT_DIRS.some((d) => padded.includes(`/${d}/`));
}

/** Scan: true when a segment of `rel` is an ignored directory name or `rel` is under an install output. */
export function isScanIgnoredRel(rel: string): boolean {
  return rel.split('/').some(shouldSkipDir) || isUnderInstallOutput(rel);
}

/**
 * Asset closure: true when `rel` (a source-relative path) or one of its directories is never
 * copied into `.palm/assets` (`CLOSURE_NEVER`: skills, root documents, manifests, `.git*`,
 * `node_modules`).
 */
export function isClosureExcluded(rel: string): boolean {
  return rel
    .split('/')
    .filter(Boolean)
    .some((segment) => CLOSURE_NEVER.some((p) => matchesPattern(p, segment)));
}

/**
 * A local source's tree hash (DESIGN.md section 4): true for a source-relative path left out.
 * `COPY_SKIP` at any depth, install outputs and `.palm` at any depth, and the root-level
 * repository files of `ROOT_IGNORED_FILES`. Every file an entity can copy stays in, so an edit
 * anywhere in an entity always moves the tree. Directories are passed by their path too.
 */
export function isTreeExcluded(rel: string): boolean {
  if (rel.split('/').some(shouldSkipFile)) return true;
  return isUnderInstallOutput(rel) || ROOT_IGNORED_FILES.includes(rel);
}
