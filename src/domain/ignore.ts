/**
 * Skip lists: the one home for what palm never scans, copies or hashes (DESIGN §5 rule 0).
 *
 * - scan (src/index): `SCAN_IGNORE_DIRS`, `INSTALL_OUTPUT_DIRS`, `ROOT_IGNORED_FILES`, `DOC_FILE_NAMES`
 * - copy (src/targets/fs-utils): `COPY_SKIP`; hook assets add `HOOK_ASSET_SKIP_TOP` / `HOOK_ASSET_SKIP_FILE`
 * - hash (src/core/hash): `HASH_SKIP`, the same list as `COPY_SKIP`
 *
 * Entries are entry names; `*.ext` matches a suffix, ignoring case.
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
 * Scan: harness install outputs committed to repos (palm or other installers wrote them) and
 * editor config. They mirror real sources elsewhere in the repo or configure the repo's own
 * development. Relative directory paths, matched at any depth.
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
  '.vscode',
];

/** Scan: repository-level files (contributor guidance, dev config), matched at the origin root only. */
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

/** Hook assets: plugin-root entries (top level only) never copied with hook scripts. */
export const HOOK_ASSET_SKIP_TOP: readonly string[] = [
  '.github',
  '.gitlab',
  '.vscode',
  '.idea',
  'docs',
  'doc',
  'website',
  'site',
  'test',
  'tests',
  '__tests__',
  'spec',
  'fixtures',
  'examples',
  'example',
  'evals',
  'assets',
  'media',
  'images',
  'screenshots',
];

/** Hook assets: repository documents at the plugin root never copied with hook scripts. */
export const HOOK_ASSET_SKIP_FILE =
  /^(README|CHANGELOG|CHANGES|HISTORY|RELEASE[-_]NOTES|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i;

/** A hook command's reference to its plugin root (`${CLAUDE_PLUGIN_ROOT}`, `$CLAUDE_PLUGIN_ROOT`, …). */
export const PLUGIN_ROOT_TOKENS =
  /\$\{(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT)\}|\$CLAUDE_PLUGIN_ROOT\b/g;

/** Hook assets: true when any command of the raw hooks references the plugin root (deploy copies it). */
export function referencesPluginRoot(raw: unknown): boolean {
  return JSON.stringify(raw ?? null).match(PLUGIN_ROOT_TOKENS) !== null;
}

/**
 * Hook assets: true for an entry of the plugin root the deploy does not copy (`rel` is its path
 * below the root): `COPY_SKIP` anywhere, `HOOK_ASSET_SKIP_TOP` and `HOOK_ASSET_SKIP_FILE` at the top.
 */
export function isSkippedHookAsset(name: string, rel: string): boolean {
  if (shouldSkipFile(name)) return true;
  return rel === name && (HOOK_ASSET_SKIP_TOP.includes(name) || HOOK_ASSET_SKIP_FILE.test(name));
}

/** True when `name` is in `list`, or matches one of its `*.ext` entries (suffix, any case). */
export function matchesSkip(list: readonly string[], name: string): boolean {
  const lower = name.toLowerCase();
  return list.some((p) =>
    p.startsWith('*.') ? lower.endsWith(p.slice(1).toLowerCase()) : p === name,
  );
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

/** Scan: true when a segment of `rel` is an ignored directory name or `rel` is under an install output. */
export function isScanIgnoredRel(rel: string): boolean {
  if (rel.split('/').some(shouldSkipDir)) return true;
  const padded = `/${rel}/`;
  return INSTALL_OUTPUT_DIRS.some((d) => padded.includes(`/${d}/`));
}
