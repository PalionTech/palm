/**
 * A literal secret found in a source (DESIGN §8, ruling 5): the index redacted it to
 * `<redacted sha256:8>`; before rendering, each redaction becomes an environment reference
 * `${NAME}`, so the entity installs, no literal is ever written, and the summary names the
 * variable to export. `--force` never brings the literal back (palm never had it).
 */

import type { Entity, McpServerConfig } from '../core/types.js';
import { detectSecrets } from '../domain/secret-refs.js';
import { isRecord } from '../lib/object.js';

const REDACTED = /<redacted sha256:[0-9a-f]{8}>/g;

/** One replaced literal: where it was and the variable that stands for it now. */
export interface ReferencedSecret {
  where: string;
  variable: string;
}

/** `docs`, `Authorization` → `DOCS_AUTHORIZATION`: an environment variable name. */
function envName(...parts: string[]): string {
  return parts
    .join('_')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hasRedaction(value: string): boolean {
  return value.search(REDACTED) >= 0;
}

class Referencer {
  readonly found: ReferencedSecret[] = [];

  /** `value` with each redaction replaced by `${variable}`. */
  replace(value: string, where: string, variable: string): string {
    if (!hasRedaction(value)) return value;
    this.found.push({ where, variable });
    return value.replace(REDACTED, `\${${variable}}`);
  }

  map(values: Record<string, string>, where: string, name: (key: string) => string) {
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, this.replace(v, `${where}.${k}`, name(k))]),
    );
  }
}

/** The variable for a secret argument: `--api-key=…` or `--api-key …` name it, else `<SERVER>_SECRET`. */
function argName(server: string, args: readonly string[], i: number): string {
  const inline = /^--?([A-Za-z][A-Za-z0-9_-]*)=/.exec(args[i] ?? '')?.[1];
  const flag = /^--?([A-Za-z][A-Za-z0-9_-]*)$/.exec(args[i - 1] ?? '')?.[1];
  return envName(server, inline ?? flag ?? 'secret');
}

function referenceMcp(cfg: McpServerConfig, r: Referencer): McpServerConfig {
  const server = cfg.name;
  const out: McpServerConfig = { ...cfg };
  const where = `mcp:${server}`;
  if (cfg.env) out.env = r.map(cfg.env, `${where}.env`, (k) => envName(k));
  if (cfg.headers)
    out.headers = r.map(cfg.headers, `${where}.headers`, (h) =>
      /^authorization$/i.test(h) ? envName(server, 'token') : envName(server, h),
    );
  if (cfg.args)
    out.args = cfg.args.map((a, i) =>
      r.replace(a, `${where}.args[${i}]`, argName(server, cfg.args ?? [], i)),
    );
  if (cfg.url !== undefined) out.url = r.replace(cfg.url, `${where}.url`, envName(server, 'url'));
  const secrets = detectSecrets(out);
  if (secrets.length) out.secrets = secrets;
  return out;
}

/** Every string of a hook set's JSON with its redactions replaced by `${<HOOK>_TOKEN}`. */
function referenceJson(value: unknown, where: string, variable: string, r: Referencer): unknown {
  if (typeof value === 'string') return r.replace(value, where, variable);
  if (Array.isArray(value))
    return value.map((v, i) => referenceJson(v, `${where}[${i}]`, variable, r));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, referenceJson(v, `${where}.${k}`, variable, r)]),
  );
}

/**
 * `entity` with every redacted literal of its definition replaced by an environment reference,
 * the secret-literal issues of its definition dropped, and what was replaced. An entity without
 * redactions comes back as it is.
 */
export function referenceSecrets(entity: Entity): { entity: Entity; replaced: ReferencedSecret[] } {
  const r = new Referencer();
  const { def } = entity;
  let next: Entity['def'] = def;
  if (def.kind === 'mcp') next = { ...def, mcp: referenceMcp(def.mcp, r) };
  if (def.kind === 'hook') {
    const raw = referenceJson(
      def.hooks.raw,
      `hook:${entity.name}`,
      envName(entity.name, 'token'),
      r,
    );
    next = { ...def, hooks: { ...def.hooks, raw } };
  }
  if (!r.found.length) return { entity, replaced: [] };
  const issues = (entity.issues ?? []).filter(
    (i) => !(i.code === 'secret-literal' && i.severity === 'critical'),
  );
  const out: Entity = { ...entity, def: next };
  if (issues.length) out.issues = issues;
  else delete out.issues;
  return { entity: out, replaced: r.found };
}

/** The summary line for one replaced literal (DESIGN §8). */
export function referencedLine(name: string, s: ReferencedSecret, harnesses: string[]): string {
  const field = s.where.replace(/^(mcp|hook):[^.]+\./, '');
  const who = harnesses.length ? harnesses.join(' or ') : 'your agent';
  return `${name}: ${field} held a literal secret in the source; written as \${${s.variable}}; export it before starting ${who}`;
}
