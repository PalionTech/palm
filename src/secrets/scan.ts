/**
 * Secret shapes (DESIGN.md section 8): which literal values look like secrets, where they sit in
 * a config or a file, and which `${VAR}` placeholders of an MCP server the user supplies.
 * Findings never carry a value, only its redacted hash.
 */
import { sha256, short } from '../core/hash.js';
import type { SecretFinding, SecretShape } from '../core/types.js';
import { isFillInValue } from '../lib/placeholders.js';
import { entropyBitsPerChar } from '../lib/text.js';

/** Known token prefixes; `-----BEGIN` opens a private key block. */
export const SECRET_PREFIXES: readonly string[] = [
  'sk-',
  'ghp_',
  'github_pat_',
  'gho_',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  'AIza',
  'glpat-',
  '-----BEGIN',
];

/** Key names under which a high-entropy value counts as a secret. */
export const SECRET_KEY_RE = /(key|token|secret|password|authorization)/i;

const PRIVATE_KEY = '-----BEGIN';
/** Characters a prefixed token needs after its prefix (`sk-abc` is not a key). */
const MIN_PREFIX_BODY = 16;
const MIN_BEARER_TOKEN = 16;
const MIN_URL_TOKEN = 8;
const MIN_ENTROPY_LENGTH = 20;
const ENTROPY_THRESHOLD = 3.5;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN_PREFIXES = SECRET_PREFIXES.filter((p) => p !== PRIVATE_KEY).map(escapeRe);
const PREFIX_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${TOKEN_PREFIXES.join('|')})[A-Za-z0-9_-]{${MIN_PREFIX_BODY},}`,
);
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/i;
const USERINFO_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:([^\s/?#@]+)@/i;
const URL_PARAM_RE = /[?&#]([A-Za-z0-9_.-]+)=([^&#\s"'`]+)/g;
const ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',;]+)/g;
/** A command-line flag without a value (`--api-key`), whose next argument is its value. */
const FLAG_RE = /^--?([A-Za-z][A-Za-z0-9_.-]*)$/;

interface Match {
  shape: SecretShape;
  /** The secret part of the text (redacted before it leaves this module). */
  secret: string;
  key?: string;
}

/** A literal worth testing: no `${VAR}`, `$VAR` or `{env:VAR}` reference, no "fill me in" text. */
function isLiteral(text: string): boolean {
  return !text.includes('$') && !text.includes('{') && !isFillInValue(text);
}

function inUrl(text: string): Match | undefined {
  const userinfo = USERINFO_RE.exec(text)?.[1];
  if (userinfo && isLiteral(userinfo)) return { shape: 'url-userinfo', secret: userinfo };
  for (const [, name = '', value = ''] of text.matchAll(URL_PARAM_RE)) {
    if (SECRET_KEY_RE.test(name) && value.length >= MIN_URL_TOKEN && isLiteral(value))
      return { shape: 'url-token', secret: value, key: name };
  }
  return undefined;
}

/** Shapes that need no key: a private key block, a known prefix, a Bearer token, a URL secret. */
function inText(text: string): Match | undefined {
  if (text.includes(PRIVATE_KEY)) return { shape: 'private-key', secret: text };
  const prefixed = PREFIX_RE.exec(text)?.[0];
  if (prefixed) return { shape: 'prefix', secret: prefixed };
  const bearer = BEARER_RE.exec(text)?.[1];
  if (bearer && bearer.length >= MIN_BEARER_TOKEN && isLiteral(bearer))
    return { shape: 'bearer', secret: bearer };
  return inUrl(text);
}

/** The first whitespace-separated token of `value` that is long and random enough. */
function highEntropyToken(value: string): string | undefined {
  return value
    .split(/\s+/)
    .find(
      (t) =>
        t.length >= MIN_ENTROPY_LENGTH &&
        !t.includes('://') &&
        isLiteral(t) &&
        entropyBitsPerChar(t) > ENTROPY_THRESHOLD,
    );
}

function findSecret(value: string, key?: string): Match | undefined {
  const found = inText(value);
  if (found || key === undefined || !SECRET_KEY_RE.test(key)) return found;
  const token = highEntropyToken(value);
  return token ? { shape: 'high-entropy', secret: token, key } : undefined;
}

/** `name=value` / `name: value` pairs anywhere in `text` whose name says "secret". */
function inAssignments(text: string): Match | undefined {
  for (const [, name = '', value = ''] of text.matchAll(ASSIGNMENT_RE)) {
    const found = SECRET_KEY_RE.test(name) ? findSecret(value, name) : undefined;
    if (found) return { ...found, key: found.key ?? name };
  }
  return undefined;
}

/**
 * The shape of `value` when it looks like a secret (DESIGN.md section 8): a known prefix, a
 * private key block, `Bearer <token>`, a URL with a password or a `token=` parameter, or 20+
 * characters above 3.5 bits of entropy per character under a key matching SECRET_KEY_RE.
 * `${VAR}` references, runtime variables and "fill me in" values are never secrets.
 */
export function looksLikeSecret(value: string, key?: string): SecretShape | undefined {
  return findSecret(value, key)?.shape;
}

/** `<redacted sha256:1a2b3c4d>`: the only form a secret value takes outside this module. */
export function redact(value: string): string {
  return `<redacted sha256:${short(sha256(value), 8)}>`;
}

function joinWhere(where: string, key: string): string {
  return where === '' || where.endsWith(':') ? `${where}${key}` : `${where}.${key}`;
}

function finding(where: string, match: Match, redacted: string): SecretFinding {
  const f: SecretFinding = { where, shape: match.shape, redacted };
  if (match.key !== undefined) f.key = match.key;
  return f;
}

interface Site {
  where: string;
  key?: string;
}

/** A `name=value` inside the text names its secret better than the key the text sits under. */
function scanString(value: string, at: Site, out: SecretFinding[]): void {
  const found = inAssignments(value) ?? findSecret(value, at.key);
  if (!found) return;
  out.push(finding(at.where, { ...found, key: found.key ?? at.key }, redact(value)));
}

function walk(value: unknown, at: Site, out: SecretFinding[]): void {
  if (typeof value === 'string') scanString(value, at, out);
  else if (Array.isArray(value)) walkArray(value, at, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      walk(v, { where: joinWhere(at.where, k), key: k }, out);
  }
}

/** Array items inherit the array's key; an item after a bare flag (`--api-key`) takes the flag's name. */
function walkArray(items: unknown[], at: Site, out: SecretFinding[]): void {
  items.forEach((item, i) => {
    const prev = items[i - 1];
    const flag = typeof prev === 'string' ? FLAG_RE.exec(prev)?.[1] : undefined;
    walk(item, { where: `${at.where}[${i}]`, key: flag ?? at.key }, out);
  });
}

/**
 * Every secret-shaped string in `value` (MCP config, hook JSON, palm.yaml data). `where`
 * prefixes each finding's path: `mcp:docs` gives `mcp:docs.headers.Authorization`,
 * `palm.yaml:` gives `palm.yaml:mcp.docs.env.KEY`, array items add `[i]`.
 */
export function scanSecrets(value: unknown, where: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  walk(value, { where }, out);
  return out;
}

/** Secret-shaped text in a file (closure scripts, rendered files): one finding per line, `where:<line>`. */
export function scanText(text: string, where: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const found = inAssignments(line) ?? inText(line);
    if (found) out.push(finding(`${where}:${i + 1}`, found, redact(found.secret)));
  });
  return out;
}

// `${VAR}` placeholders an MCP server needs: pure helpers of the model (src/domain/secret-refs.ts).
export {
  allSecrets,
  detectSecrets,
  optionalSecretNames,
  requiredSecretNames,
} from '../domain/secret-refs.js';
