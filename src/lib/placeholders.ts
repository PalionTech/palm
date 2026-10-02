/**
 * The `${VAR}` placeholder grammar used in MCP configs, hooks and recorded values:
 * `${VAR}`, `${env:VAR}`, `${VAR:-default}` and `${env:VAR:-default}`.
 */

/** Every placeholder (global flag; groups: 1 = variable name, 2 = default after `:-`). */
export const PLACEHOLDER_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** `${VAR}`, `${env:VAR}` (VS Code, Cursor) or `${VAR:-default}`. */
export type PlaceholderStyle = 'dollar' | 'env-colon' | 'dollar-default';

/** One placeholder occurrence. `default` is set when the token has a `:-` part. */
export interface Placeholder {
  name: string;
  style: PlaceholderStyle;
  default?: string;
  /** The token exactly as written. */
  raw: string;
}

const ENV_PREFIX = `\${env:`;

function toPlaceholder(raw: string, name: string, def: string | undefined): Placeholder {
  let style: PlaceholderStyle = 'dollar';
  if (raw.startsWith(ENV_PREFIX)) style = 'env-colon';
  else if (def !== undefined) style = 'dollar-default';
  return def === undefined ? { name, style, raw } : { name, style, default: def, raw };
}

/** Every placeholder in `text`, in order of appearance. */
export function findPlaceholders(text: string): Placeholder[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => toPlaceholder(m[0], m[1] as string, m[2]));
}

/** The placeholder when `text` is exactly one token, else undefined. */
export function parsePlaceholder(text: string): Placeholder | undefined {
  const [first, ...rest] = findPlaceholders(text);
  return first && rest.length === 0 && first.raw === text ? first : undefined;
}

/** `text` with each placeholder replaced by `fn(placeholder)`; undefined keeps the token as written. */
export function replacePlaceholders(
  text: string,
  fn: (p: Placeholder) => string | undefined,
): string {
  return text.replace(
    PLACEHOLDER_RE,
    (raw: string, name: string, def: string | undefined) =>
      fn(toPlaceholder(raw, name, def)) ?? raw,
  );
}

/** A reference to variable `name`: `${name}`, `${env:name}` or `${name:-fallback}`. */
export function envRef(name: string, style: PlaceholderStyle = 'dollar', fallback = ''): string {
  if (style === 'env-colon') return `\${env:${name}}`;
  if (style === 'dollar-default') return `\${${name}:-${fallback}}`;
  return `\${${name}}`;
}

/**
 * Variables a harness or the OS provides at run time. They are never user secrets: nothing
 * prompts for them, reports them or rewrites their tokens. The one list for the code base.
 */
export const RUNTIME_VARS: ReadonlySet<string> = new Set([
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
  'CURSOR_PLUGIN_ROOT',
  'CURSOR_PROJECT_DIR',
  'GEMINI_PROJECT_DIR',
  'PLUGIN_ROOT',
  'extensionPath',
  'workspaceFolder',
  'workspaceFolderBasename',
  'workspaceRoot',
  'userHome',
  'pathSeparator',
  'HOME',
  'USER',
  'PWD',
  'PATH',
  'TMPDIR',
]);

/** True when `name` is in RUNTIME_VARS. */
export function isRuntimeVar(name: string): boolean {
  return RUNTIME_VARS.has(name);
}

/** True for values that obviously mean "fill me in": `""`, `<your key>`, `your-token-here`. */
export function isFillInValue(value: string): boolean {
  return value === '' || /^<.*>$/.test(value) || /^your[-_ ]/i.test(value);
}
