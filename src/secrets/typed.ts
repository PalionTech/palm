/**
 * Values the person typed for an MCP server (DESIGN §8; rulings J1, L3, D7): `--env K=V`,
 * `--header K=V`, a README snippet, a server under `mcp:` in palm.yaml. Under the default
 * `env-ref` policy none of them reaches a file as a literal: palm writes an environment
 * reference in its place (`K=V` becomes `${K}`) and says which variable to export. The values
 * stay in memory for `--secrets literal`, the one way to store a value; they are never printed.
 *
 * What becomes a reference:
 *
 * - from flags (`from.type: flags`), an `--env` or `--header` value under a secret-shaped key
 *   or shaped like a secret (J2'); any other typed value (`LOG_LEVEL=debug`) is written as
 *   typed, with a note (`plain`);
 * - from flags, an `--arg` that looks like a secret or follows a flag named like one
 *   (`--arg --api-key --arg <value>`, `--arg --api-key=<value>`, J1');
 * - from a snippet or palm.yaml, a literal under a secret-shaped key (API_KEY, Authorization,
 *   x-api-key; paths excepted) and any secret-shaped value;
 * - everywhere, a fill-in placeholder under a secret-shaped key (`Bearer YOUR_API_KEY`,
 *   `<your-token>`, `xxx`, `changeme`), named from the placeholder (`CONTEXT7_API_KEY`), and a
 *   VS Code input `${input:github_mcp_pat}`, which becomes `${GITHUB_MCP_PAT}`;
 * - a secret-shaped argument or URL part (a prefixed token, a `token=` parameter).
 */
import type { McpServerConfig } from '../core/types.js';
import {
  argVariable,
  detectSecrets,
  envVariableName,
  headerVariable,
  serverVariable,
} from '../domain/secret-refs.js';
import { orList } from './policy.js';
import { isFillIn, isSecretKey, redact, secretPart, urlSecret } from './scan.js';

/** Why a typed value became a reference. */
type TypedWhy = 'typed' | 'secret' | 'fill-in' | 'input';

export interface TypedReference {
  /** `env.BRAVE_API_KEY`, `headers.Authorization`, `args[2]`, `url`. */
  where: string;
  variable: string;
  /** The value the reference stands for, for `--secrets literal`; empty for a fill-in or an input. */
  value: string;
  why: TypedWhy;
  /** The placeholder as written, for a fill-in (`YOUR_API_KEY`) or an input (`${input:pat}`). */
  placeholder?: string;
}

/** An auth scheme kept in front of the reference: `Bearer ${DOCS_TOKEN}`. */
const SCHEME = /^((?:Bearer|Basic|Token)\s+)(.*)$/i;
const INPUT_RE = /\$\{input:([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const REFERENCE_RE = /\$\{[^}]+\}|\{env:[^}]+\}/;

function reference(variable: string): string {
  return `\${${variable}}`;
}

function hasReference(value: string): boolean {
  return REFERENCE_RE.test(value);
}

/** The name a fill-in placeholder spells (`YOUR_API_KEY` → `API_KEY`, `<your-token>` → `token`). */
function fillInName(text: string): string | undefined {
  const t = text.trim();
  if (!/^(?:<.*>|your[-_ .].*)$/i.test(t)) return undefined;
  const name = t.replace(/^<|>$/g, '').replace(/^your[-_ .]+/i, '');
  return /^[A-Za-z][A-Za-z0-9_ .-]*$/.test(name) ? name : undefined;
}

function isPathLike(text: string): boolean {
  return /^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)/.test(text);
}

interface Site {
  key: string;
  where: string;
  /** The variable when the value is typed or secret. */
  variable: string;
}

/** A typed `--env` or `--header` value that is no secret: written as typed (J2'). */
export interface PlainValue {
  /** `env.LOG_LEVEL`, `headers.X-Region`. */
  where: string;
}

/**
 * J2': a typed value is a secret when its key says so (API_KEY, Authorization) or the value is
 * shaped like one; `LOG_LEVEL=debug` is not.
 */
function typedSecret(key: string, value: string): boolean {
  return isSecretKey(key) || secretPart(value, key) !== undefined;
}

class Typed {
  readonly references: TypedReference[] = [];
  readonly plain: PlainValue[] = [];

  constructor(
    readonly server: string,
    readonly fromFlags: boolean,
  ) {}

  /** `${input:name}` → `${NAME}`, each recorded once per place. */
  inputs(value: string, where: string): string {
    return value.replace(INPUT_RE, (raw: string, name: string) => {
      const variable = envVariableName(name);
      this.references.push({ where, variable, value: '', why: 'input', placeholder: raw });
      return reference(variable);
    });
  }

  /** A typed value that stays as typed: noted once per place. */
  private kept(site: Site): undefined {
    this.plain.push({ where: site.where });
    return undefined;
  }

  /** Why the literal `text` at `site` becomes a reference, or undefined when it stays. */
  private why(text: string, site: Site): TypedWhy | undefined {
    const secretKey = isSecretKey(site.key);
    if (secretKey && isFillIn(text)) return 'fill-in';
    if (text.trim() === '') return undefined;
    if (this.fromFlags) return typedSecret(site.key, text) ? 'typed' : this.kept(site);
    if (secretPart(text, site.key) !== undefined) return 'secret';
    return secretKey && !isPathLike(text) ? 'secret' : undefined;
  }

  /** An env or header value: the whole value (after an auth scheme) becomes the reference. */
  whole(raw: string, site: Site, named?: (placeholder: string) => string | undefined): string {
    const value = this.inputs(raw, site.where);
    if (hasReference(value)) return value;
    const [, scheme = '', text = value] = SCHEME.exec(value) ?? [];
    const why = this.why(text, site);
    if (!why) return value;
    const fillIn = why === 'fill-in';
    const variable = (fillIn && named?.(text)) || site.variable;
    this.references.push(
      fillIn
        ? { where: site.where, variable, value: '', why, placeholder: text }
        : { where: site.where, variable, value: text, why },
    );
    return `${scheme}${reference(variable)}`;
  }

  /**
   * J1': a typed argument after a flag named like a secret (`--api-key <value>`, or the value
   * of `--api-key=<value>`) becomes the reference whole, whatever it looks like; any other
   * argument as `part`.
   */
  arg(raw: string, site: Site, prefix = ''): string {
    const value = raw.slice(prefix.length);
    const named = this.fromFlags && isSecretKey(site.key) && !/^--?[A-Za-z]/.test(value);
    if (!named || value.trim() === '' || hasReference(value)) return this.part(raw, site);
    this.references.push({ where: site.where, variable: site.variable, value, why: 'typed' });
    return `${prefix}${reference(site.variable)}`;
  }

  /** An argument or the URL: only a secret-shaped part becomes the reference. */
  part(raw: string, site: Site): string {
    const value = this.inputs(raw, site.where);
    const secret = hasReference(value) ? undefined : secretPart(value, site.key);
    if (!secret) return value;
    this.references.push({
      where: site.where,
      variable: site.variable,
      value: secret,
      why: 'secret',
    });
    return value.replace(secret, reference(site.variable));
  }
}

function envOf(t: Typed, env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      t.whole(v, { key: k, where: `env.${k}`, variable: envVariableName(k) }),
    ]),
  );
}

function headersOf(t: Typed, headers: Record<string, string>): Record<string, string> {
  const named = (text: string) => {
    const name = fillInName(text);
    return name === undefined ? undefined : serverVariable(t.server, name);
  };
  return Object.fromEntries(
    Object.entries(headers).map(([h, v]) => [
      h,
      t.whole(v, { key: h, where: `headers.${h}`, variable: headerVariable(t.server, h) }, named),
    ]),
  );
}

const FLAG = /^--?([A-Za-z][A-Za-z0-9_-]*)$/;
const INLINE_FLAG = /^(--?([A-Za-z][A-Za-z0-9_-]*)=)/;

function argsOf(t: Typed, args: readonly string[]): string[] {
  return args.map((a, i) => {
    const flag = FLAG.exec(args[i - 1] ?? '')?.[1];
    const inline = flag === undefined ? INLINE_FLAG.exec(a) : null;
    const key = flag ?? inline?.[2] ?? '';
    const site = { key, where: `args[${i}]`, variable: argVariable(t.server, args, i) };
    return t.arg(a, site, inline?.[1]);
  });
}

/**
 * `cfg` with every typed value that must not be written literally replaced by an environment
 * reference, and the list of what was replaced (the values for `--secrets literal`). The
 * `secrets` list is recomputed from the references.
 */
export function referenceTyped(cfg: McpServerConfig): {
  cfg: McpServerConfig;
  references: TypedReference[];
  /** J2': typed values written as typed (no secret); the engine notes each with `plainLine`. */
  plain: PlainValue[];
} {
  const t = new Typed(cfg.name, cfg.from?.type === 'flags');
  const out: McpServerConfig = { ...cfg };
  if (cfg.env) out.env = envOf(t, cfg.env);
  if (cfg.headers) out.headers = headersOf(t, cfg.headers);
  if (cfg.args) out.args = argsOf(t, cfg.args);
  if (cfg.url !== undefined)
    out.url = t.part(cfg.url, {
      key: 'url',
      where: 'url',
      variable: urlVariable(cfg.name, cfg.url),
    });
  if (t.references.length) {
    const secrets = detectSecrets(out);
    if (secrets.length) out.secrets = secrets;
  }
  return { cfg: out, references: t.references, plain: t.plain };
}

/**
 * The variable a secret in a server's URL is written as (S10): named after the parameter it
 * sits under (`?key=…` of remote → `REMOTE_KEY`), else `<SERVER>_TOKEN`; the rest of the URL,
 * host included, stays as written.
 */
export function urlVariable(server: string, url: string): string {
  return serverVariable(server, urlSecret(url)?.param ?? 'token');
}

/** J2' `docs: env.LOG_LEVEL is written as you typed it (no secret)`: the `i` note for a plain value. */
export function plainLine(server: string, value: PlainValue): string {
  return `${server}: ${value.where} is written as you typed it (not a secret); a key or value that looks like a secret becomes a \${VAR} reference`;
}

/** The values to render under `--secrets literal`, by variable (fill-ins and inputs have none). */
export function typedValues(references: readonly TypedReference[]): Record<string, string> {
  return Object.fromEntries(
    references.filter((r) => r.value !== '').map((r) => [r.variable, r.value]),
  );
}

function whatWasThere(ref: TypedReference): string {
  if (ref.why === 'input') return `${ref.placeholder} is a VS Code input`;
  if (ref.why === 'fill-in') return `${ref.where} held the placeholder ${ref.placeholder}`;
  if (ref.why === 'secret') return `${ref.where} held a literal secret`;
  return `${ref.where} is not written as the value you typed`;
}

/**
 * The line for one reference (J1, L3, D7): `brave-search: env.BRAVE_API_KEY is not written as
 * the value you typed; written as ${BRAVE_API_KEY}; export BRAVE_API_KEY=… before starting
 * Claude Code, Codex or Cursor`. The value itself never appears.
 */
export function typedLine(
  server: string,
  ref: TypedReference,
  harnesses: readonly string[],
): string {
  const who = harnesses.length ? orList([...harnesses]) : 'your agent';
  const tail = ref.why === 'typed' ? ' (--secrets literal stores the value instead)' : '';
  return `${server}: ${whatWasThere(ref)}; written as ${reference(ref.variable)}; export ${ref.variable}=… before starting ${who}${tail}`;
}

/** `--env K=V` / `--header H=V` values of a command line, with their option. */
const TYPED_OPTIONS = new Set(['--env', '--header']);

/** The server an `install mcp <name>` command line names ('' when none). */
function serverOf(args: readonly string[]): string {
  const at = args.indexOf('mcp');
  const name = at < 0 ? undefined : args.slice(at + 1).find((a) => !a.startsWith('-'));
  return name ?? '';
}

/**
 * `K=V` of `option` with the value replaced by the reference palm writes for it, when palm
 * writes one (J2': a secret-shaped key or value); a plain value stays as typed.
 */
function typedPair(option: string, pair: string, server: string): string {
  const eq = pair.indexOf('=');
  if (eq < 0) return pair;
  const key = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  if (value === '' || hasReference(value)) return pair;
  const [, scheme = '', text = value] = SCHEME.exec(value) ?? [];
  if (!typedSecret(key, text)) return pair;
  const variable = option === '--env' ? envVariableName(key) : headerVariable(server, key);
  return `${key}=${scheme}${reference(variable)}`;
}

/** Any other argument with its secret-shaped part redacted. */
function redactedArg(arg: string): string {
  const secret = secretPart(arg);
  return secret ? arg.replace(secret, redact(secret)) : arg;
}

/** The `--arg` values of a command line, in order (`--arg X` and `--arg=X`). */
function typedArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--arg' && i + 1 < args.length) out.push(args[++i] ?? '');
    else if (arg.startsWith('--arg=')) out.push(arg.slice('--arg='.length));
  }
  return out;
}

/**
 * The command line as typed, safe to repeat in a hint (J11): each `--env` and `--header`
 * value palm writes as a reference becomes that reference (`--env 'K=${K}'`, the same install
 * under env-ref), each `--arg` palm references likewise (J1'), and any other secret-shaped
 * argument is redacted.
 */
export function redactTypedArgs(args: readonly string[]): string[] {
  const server = serverOf(args);
  const r = { server, written: argsOf(new Typed(server, true), typedArgs(args)) };
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const [words, used] = redactOne(args, i, r);
    out.push(...words);
    i += used;
  }
  return out;
}

/**
 * Argument `i` (and the value it takes) as a hint repeats it: the words, and how many
 * arguments they stand for. `r.written` holds the `--arg` values as palm writes them, in order.
 */
function redactOne(
  args: readonly string[],
  i: number,
  r: { server: string; written: string[] },
): [string[], number] {
  const arg = args[i] ?? '';
  const next = args[i + 1];
  const [option = '', inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg];
  if (inline !== undefined && TYPED_OPTIONS.has(option))
    return [[`${option}=${typedPair(option, inline, r.server)}`], 1];
  if (inline !== undefined && option === '--arg') return [[`--arg=${r.written.shift() ?? ''}`], 1];
  if (next !== undefined && TYPED_OPTIONS.has(arg))
    return [[arg, typedPair(arg, next, r.server)], 2];
  if (next !== undefined && arg === '--arg') return [[arg, r.written.shift() ?? ''], 2];
  return [[redactedArg(arg)], 1];
}
