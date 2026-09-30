/**
 * Secrets pass (DESIGN §5 "Scan issues", §8): secret-shaped literals in MCP `env`, `headers`,
 * `args` and `url`, in hook commands (and a Copilot hook's `env`) and in closure files become
 * `secret-literal` issues: critical in a definition, a warning inside a closure file. A value found
 * in a definition is replaced by `<redacted sha256:8>`, so the index never holds it. MCP servers
 * then get `secrets`, the variables they need, from the redacted definition.
 *
 * Every file a skill, agent or instruction copies is scanned too (ruling Y2): a credential there
 * is critical, since the file is written as it is and palm never writes a literal from a source;
 * a random value in code or prose is a warning (`copiedSeverity`).
 *
 * The shapes and the redaction are `src/secrets/scan.ts`; scan.ts passes them in.
 */

import type {
  Entity,
  EntityIssue,
  McpServerConfig,
  SecretFinding,
  SecretRef,
  SecretShape,
} from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { hookHandlers } from './hooks.js';
import { addIssues } from './issues.js';
import type { ScanContext } from './scan-context.js';
import {
  closureFiles,
  closureOfEntity,
  ownFiles,
  readScannable,
  type SourceFile,
} from './source-files.js';

/** The part of `src/secrets/scan.ts` the scanner uses (API.md). */
export interface SecretScanner {
  scanSecrets(value: unknown, where: string): SecretFinding[];
  scanText(text: string, where: string): SecretFinding[];
  redact(value: string): string;
  detectSecrets(cfg: McpServerConfig): SecretRef[];
  /** S10: the secret part of a URL (a password, a `key=` parameter), so the host stays. */
  urlSecret(url: string): { secret: string; param?: string } | undefined;
}

const SHAPES: Record<SecretShape, string> = {
  prefix: 'a known token prefix',
  bearer: 'a Bearer token',
  'private-key': 'a private key',
  'high-entropy': 'a high-entropy value',
  'url-userinfo': 'a password in the URL',
  'url-token': 'a token in the URL',
};

function issueOf(f: SecretFinding, file: string, severity: EntityIssue['severity']): EntityIssue {
  const message = `${f.where}: literal secret (${SHAPES[f.shape]}) ${f.redacted}`;
  return { code: 'secret-literal', severity, message, file };
}

/** Scans values in place: a value with findings is replaced by its redaction. */
class Redactor {
  readonly issues: EntityIssue[] = [];

  constructor(
    private readonly scanner: SecretScanner,
    private readonly file: string,
  ) {}

  private record(findings: SecretFinding[]): void {
    this.issues.push(...findings.map((f) => issueOf(f, this.file, 'critical')));
  }

  /** `value` or its redaction; `key` makes key-name heuristics apply (`API_KEY: …`). */
  value(value: string, where: string, key?: string): string {
    const findings = this.scanner.scanSecrets(key === undefined ? value : { [key]: value }, where);
    if (findings.length === 0) return value;
    this.record(findings);
    // `Bearer <token>` keeps its scheme, so the render can write `Bearer ${VAR}` in its place.
    const bearer = /^(Bearer\s+)(\S+)$/i.exec(value);
    if (bearer) return `${bearer[1]}${this.scanner.redact(bearer[2] ?? '')}`;
    return this.scanner.redact(value);
  }

  /** S10: a URL with only its secret part redacted (`?key=<redacted …>`); the host stays. */
  url(value: string, where: string): string {
    const findings = this.scanner.scanSecrets(value, where);
    if (findings.length === 0) return value;
    this.record(findings);
    const part = this.scanner.urlSecret(value)?.secret;
    return part ? value.replace(part, this.scanner.redact(part)) : this.scanner.redact(value);
  }

  /**
   * An argument list scanned whole, so a value after `--api-key` is judged by the flag's name;
   * findings name the item as `<where>[i]`. An item it cannot place redacts every argument.
   */
  list(values: string[], where: string): string[] {
    const findings = this.scanner.scanSecrets(values, where);
    if (findings.length === 0) return values;
    this.record(findings);
    const hit = findings.map((f) => Number(/\[(\d+)\]$/.exec(f.where)?.[1] ?? Number.NaN));
    const all = hit.some((i) => Number.isNaN(i));
    return values.map((v, i) => (all || hit.includes(i) ? this.scanner.redact(v) : v));
  }

  /** Every string value of a key → value map (env, headers), keyed for the heuristics. */
  map<T extends Record<string, unknown>>(values: T, where: string): T {
    const entries = Object.entries(values).map(([k, v]) => [
      k,
      typeof v === 'string' ? this.value(v, where, k) : v,
    ]);
    return Object.fromEntries(entries) as T;
  }
}

function redactMcp(cfg: McpServerConfig, r: Redactor): void {
  const where = `mcp:${cfg.name}`;
  if (cfg.env) cfg.env = r.map(cfg.env, `${where}.env`);
  if (cfg.headers) cfg.headers = r.map(cfg.headers, `${where}.headers`);
  if (cfg.args) cfg.args = r.list(cfg.args, `${where}.args`);
  if (cfg.url !== undefined) cfg.url = r.url(cfg.url, `${where}.url`);
}

function redactHooks(name: string, raw: unknown, r: Redactor): void {
  for (const { event, matcher, handler } of hookHandlers(raw)) {
    const where = `hook:${name}#${event}//${matcher ?? '-'}`;
    for (const key of ['command', 'bash', 'powershell']) {
      const v = handler[key];
      if (typeof v === 'string') handler[key] = r.value(v, where);
    }
    if (isRecord(handler.env)) handler.env = r.map(handler.env, `${where}.env`);
  }
}

/** Redact the definition; returns its critical issues. */
function definitionIssues(e: Entity, scanner: SecretScanner): EntityIssue[] {
  const r = new Redactor(scanner, e.path);
  if (e.def.kind === 'hook') redactHooks(e.name, e.def.hooks.raw, r);
  if (e.def.kind === 'mcp') {
    redactMcp(e.def.mcp, r);
    const secrets = scanner.detectSecrets(e.def.mcp);
    if (secrets.length > 0) e.def.mcp.secrets = secrets;
  }
  return r.issues;
}

/** How bad one finding in a file is. */
type Severity = (f: SecretFinding, file: string) => EntityIssue['severity'];

async function fileIssues(
  file: SourceFile,
  scanner: SecretScanner,
  severity: Severity,
): Promise<EntityIssue[]> {
  const text = await readScannable(file.abs);
  if (text === undefined) return [];
  return scanner.scanText(text, file.rel).map((f) => issueOf(f, file.rel, severity(f, file.rel)));
}

/** Files whose `name = value` lines are configuration, where a random value is a credential. */
const DATA_FILE = /(^|\/)\.env(\.[^/]*)?$|\.(json|jsonc|toml|ya?ml|ini|cfg|conf|properties)$/i;

/**
 * A copied file's finding refuses the entity when it is a credential beyond doubt: a known token
 * prefix, a Bearer token, a secret in a URL, a private key block, or a random value in a
 * configuration file. A random value in code or prose (`apiKey = hash(input)`) is a warning:
 * palm cannot tell it from a secret, so it says so and copies. A certificate or a public key
 * block is no secret shape at all (secrets/scan.ts).
 */
const copiedSeverity: Severity = (f, file) => {
  if (f.shape === 'high-entropy') return DATA_FILE.test(file) ? 'critical' : 'warning';
  return 'critical';
};

async function closureIssues(
  ctx: ScanContext,
  e: Entity,
  scanner: SecretScanner,
): Promise<EntityIssue[]> {
  const closure = closureOfEntity(e);
  if (!closure) return [];
  // The definition files were scanned value by value above.
  const own = new Set([e.path, ...(ctx.extraSources.get(e) ?? [])]);
  const files = (await closureFiles(ctx, closure)).filter((f) => !own.has(f.rel));
  return (await Promise.all(files.map((f) => fileIssues(f, scanner, () => 'warning')))).flat();
}

/** Kinds whose files are copied or converted as they are (their text is the render). */
const COPIED_KINDS: ReadonlySet<Entity['kind']> = new Set(['skill', 'agent', 'instruction']);

/** Every file a skill, agent or instruction deploys: a literal refuses the entity. */
async function copiedIssues(
  ctx: ScanContext,
  e: Entity,
  scanner: SecretScanner,
): Promise<EntityIssue[]> {
  const files = await ownFiles(ctx, e);
  return (await Promise.all(files.map((f) => fileIssues(f, scanner, copiedSeverity)))).flat();
}

async function entityIssues(
  ctx: ScanContext,
  e: Entity,
  scanner: SecretScanner,
): Promise<EntityIssue[]> {
  if (COPIED_KINDS.has(e.kind)) return copiedIssues(ctx, e, scanner);
  if (e.kind !== 'hook' && e.kind !== 'mcp') return [];
  return [...definitionIssues(e, scanner), ...(await closureIssues(ctx, e, scanner))];
}

/**
 * Scan every entity of the scan: hook sets and MCP servers value by value (redacted in place)
 * plus their closures, and the files skills, agents and instructions copy.
 */
export async function checkSecrets(ctx: ScanContext, scanner: SecretScanner): Promise<void> {
  const entities = ctx.registry.entities;
  const found = await Promise.all(entities.map((e) => entityIssues(ctx, e, scanner)));
  entities.forEach((e, i) => {
    addIssues(e, found[i] ?? []);
  });
}
