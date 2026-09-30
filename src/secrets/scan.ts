/**
 * Secret shapes (DESIGN.md section 8): which literal values look like secrets, where they sit in
 * a config or a file, and which `${VAR}` placeholders of an MCP server the user supplies.
 * Findings never carry a value, only its redacted hash.
 */
import { sha256, short } from '../core/hash.js';
import type { SecretFinding, SecretShape } from '../core/types.js';
import { isFillInValue } from '../lib/placeholders.js';
import { entropyBitsPerChar } from '../lib/text.js';

/** Known token prefixes; `-----BEGIN` opens a key block (a secret only when it says PRIVATE KEY). */
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

/**
 * Key names under which a high-entropy value counts as a secret: one of the words key, token,
 * secret, password, authorization or api key, as a whole word of the name (separated by `_`,
 * `-`, `.` or the name's ends), so `API_KEY` and `x-api-key` match and `keywords` does not.
 * Test names through `isSecretKey`, which also splits camelCase (`clientSecret`).
 */
export const SECRET_KEY_RE =
  /(?<![a-z0-9])(?:api[_-]?key|key|token|secret|password|authorization)(?![a-z0-9])/i;

/** True when the key name `name` says "secret" (SECRET_KEY_RE over its words, camelCase split). */
export function isSecretKey(name: string): boolean {
  return SECRET_KEY_RE.test(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

const PRIVATE_KEY = '-----BEGIN';
/** A private key block's armour line; a certificate or a public key is no secret. */
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
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
const ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(["'`]?)([^\s"'`,;]+)/g;
/**
 * S12 X7 T13 Q2 B10 Y5': code, never a value: a call or an index (`React.useContext(Ctx)`,
 * `z.string()`, `os.environ["X"]`), a non-null assertion (`process.env.X!`), or a member
 * chain from a short word (`process.env.X`, `crpc.http.list`); a JWT's first segment is longer.
 */
const CODE_EXPRESSION = /[()[\]{}]|=>|!$|^[A-Za-z_$][A-Za-z_$]{0,15}(?:\??\.[A-Za-z_$][\w$]*)+/;
/** Source files where an unquoted word on the right-hand side is an identifier, not a literal. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kts?|rs|swift|php|cs|scala|dart)$/i;
/** An identifier as code names one (`TokenContext`, `DEFAULT_API_KEY`); random tokens carry digits. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*$/;
/** A command-line flag without a value (`--api-key`), whose next argument is its value. */
const FLAG_RE = /^--?([A-Za-z][A-Za-z0-9_.-]*)$/;

interface Match {
  shape: SecretShape;
  /** The secret part of the text (redacted before it leaves this module). */
  secret: string;
  key?: string;
}

const FILL_IN: readonly RegExp[] = [
  /^$/,
  /^<[^<>]*>$/,
  /^your[-_ .]/i,
  /^x{3,}(?:[-_.]?x+)*$/i,
  /^(?:change|replace)[-_ ]?me$/i,
  /^\*{3,}$/,
];

/** True for text that means "fill me in": empty, `<your key>`, `YOUR_API_KEY`, `xxxx`, `changeme`. */
export function isFillIn(text: string): boolean {
  const t = text.trim();
  return FILL_IN.some((re) => re.test(t));
}

/** A prefixed token whose body is a fill-in (`ghp_xxxxxxxxxxxxxxxxxxxx`, `sk-your-key-goes-here`). */
function isFillInToken(token: string): boolean {
  const prefix = SECRET_PREFIXES.find((p) => token.startsWith(p)) ?? '';
  return isFillIn(token.slice(prefix.length));
}

/** A literal worth testing: no `${VAR}`, `$VAR` or `{env:VAR}` reference, no "fill me in" text. */
function isLiteral(text: string): boolean {
  return !text.includes('$') && !text.includes('{') && !isFillInValue(text);
}

function inUrl(text: string): Match | undefined {
  const userinfo = USERINFO_RE.exec(text)?.[1];
  if (userinfo && isLiteral(userinfo)) return { shape: 'url-userinfo', secret: userinfo };
  for (const [, name = '', value = ''] of text.matchAll(URL_PARAM_RE)) {
    if (isSecretKey(name) && value.length >= MIN_URL_TOKEN && isLiteral(value))
      return { shape: 'url-token', secret: value, key: name };
  }
  return undefined;
}

/**
 * S10: the secret part of a URL (a password, a `key=` or `token=` parameter) and the parameter
 * it sits under, so a reference can replace that part alone and the host stays readable.
 */
export function urlSecret(url: string): { secret: string; param?: string } | undefined {
  const found = inUrl(url);
  const secret = found?.secret ?? findSecret(url)?.secret;
  if (secret === undefined) return undefined;
  const param =
    found?.key ?? [...url.matchAll(URL_PARAM_RE)].find(([, , value]) => value === secret)?.[1];
  return param === undefined ? { secret } : { secret, param };
}

/** Shapes that need no key: a private key block, a known prefix, a Bearer token, a URL secret. */
function inText(text: string): Match | undefined {
  if (PRIVATE_KEY_RE.test(text)) return { shape: 'private-key', secret: text };
  const prefixed = PREFIX_RE.exec(text)?.[0];
  if (prefixed && !isFillInToken(prefixed)) return { shape: 'prefix', secret: prefixed };
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
        !CODE_EXPRESSION.test(t) &&
        entropyBitsPerChar(t) > ENTROPY_THRESHOLD,
    );
}

function findSecret(value: string, key?: string): Match | undefined {
  const found = inText(value);
  if (found || key === undefined || !isSecretKey(key)) return found;
  const token = highEntropyToken(value);
  return token ? { shape: 'high-entropy', secret: token, key } : undefined;
}

/** `name=value` / `name: value` pairs anywhere in `text` whose name says "secret". */
function inAssignments(text: string, code = false): Match | undefined {
  for (const [, name = '', quote = '', value = ''] of text.matchAll(ASSIGNMENT_RE)) {
    if (code && quote === '' && IDENTIFIER.test(value)) continue;
    const found = isSecretKey(name) ? findSecret(value, name) : undefined;
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

/**
 * The secret part of `value` (the token after `Bearer`, the value of a `token=` parameter, a
 * prefixed token inside an argument), for the one caller that replaces it by a reference in
 * place; undefined when `value` holds no secret shape.
 */
export function secretPart(value: string, key?: string): string | undefined {
  return (inAssignments(value) ?? findSecret(value, key))?.secret;
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
  const code = CODE_FILE.test(where);
  text.split(/\r?\n/).forEach((line, i) => {
    const found = inAssignments(line, code) ?? inText(line);
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
