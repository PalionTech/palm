/**
 * A literal secret found in a source (DESIGN §8, ruling 5): the index redacted it to
 * `<redacted sha256:8>`; before rendering, each redaction (and a high-entropy value under any
 * env key or header of a source, S1) becomes an environment reference
 * `${NAME}`, so the entity installs, no literal is ever written, and the summary names the
 * variable to export. `--force` never brings the literal back (palm never had it).
 */

import type { Entity, McpServerConfig } from '../core/types.js';
import {
  argVariable,
  detectSecrets,
  envVariableName,
  headerVariable,
} from '../domain/secret-refs.js';
import { isRecord } from '../lib/object.js';
import { secretPart } from '../secrets/scan.js';
import { MANIFEST_SOURCE } from './sources.js';

const REDACTED = /<redacted sha256:[0-9a-f]{8}>/g;

/** One replaced literal: where it was and the variable that stands for it now. */
export interface ReferencedSecret {
  where: string;
  variable: string;
}

function hasRedaction(value: string): boolean {
  return value.search(REDACTED) >= 0;
}

/**
 * Sofia S1: the high-entropy part of a value a source ships under an env key or a header, whatever
 * the key is called (`CREDENTIALS`, `X-Session`); undefined for references, words, URLs and
 * "fill me in" text. The scanner's own rule, asked as if the key said "token".
 */
function shippedLiteral(value: string): string | undefined {
  return secretPart(value, 'token');
}

class Referencer {
  readonly found: ReferencedSecret[] = [];

  /** `fromSource`: high-entropy literals in env and header values are referenced too (S1). */
  constructor(private readonly fromSource: boolean) {}

  /** `value` with each redaction replaced by `${variable}`. */
  replace(value: string, where: string, variable: string): string {
    if (!hasRedaction(value)) return value;
    this.found.push({ where, variable });
    return value.replace(REDACTED, `\${${variable}}`);
  }

  /** `replace`, and a source's high-entropy literal replaced by `${variable}` as well (S1). */
  private replaceValue(value: string, where: string, variable: string): string {
    const next = this.replace(value, where, variable);
    const literal = this.fromSource && next === value ? shippedLiteral(value) : undefined;
    if (!literal) return next;
    this.found.push({ where, variable });
    return value.split(literal).join(`\${${variable}}`);
  }

  map(values: Record<string, string>, where: string, name: (key: string) => string) {
    return Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, this.replaceValue(v, `${where}.${k}`, name(k))]),
    );
  }
}

function referenceMcp(cfg: McpServerConfig, r: Referencer): McpServerConfig {
  const server = cfg.name;
  const out: McpServerConfig = { ...cfg };
  const where = `mcp:${server}`;
  if (cfg.env) out.env = r.map(cfg.env, `${where}.env`, (k) => envVariableName(k));
  if (cfg.headers)
    out.headers = r.map(cfg.headers, `${where}.headers`, (h) => headerVariable(server, h));
  if (cfg.args)
    out.args = cfg.args.map((a, i) =>
      r.replace(a, `${where}.args[${i}]`, argVariable(server, cfg.args ?? [], i)),
    );
  if (cfg.url !== undefined)
    out.url = r.replace(cfg.url, `${where}.url`, envVariableName(server, 'url'));
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
  const r = new Referencer(entity.source !== MANIFEST_SOURCE);
  const { def } = entity;
  let next: Entity['def'] = def;
  if (def.kind === 'mcp') next = { ...def, mcp: referenceMcp(def.mcp, r) };
  if (def.kind === 'hook') {
    const raw = referenceJson(
      def.hooks.raw,
      `hook:${entity.name}`,
      envVariableName(entity.name, 'token'),
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

/**
 * The line for one replaced literal (DESIGN §8): `docs: headers.Authorization held a literal
 * secret in the source; written as ${DOCS_TOKEN}; export it before starting Claude Code`.
 */
export function referencedLine(
  name: string,
  s: ReferencedSecret,
  harnesses: string[],
  where = ' in the source',
): string {
  const field = s.where.replace(/^(mcp|hook):[^.]+\./, '');
  const who = harnesses.length ? harnesses.join(' or ') : 'your agent';
  return `${name}: ${field} held a literal secret${where}; written as \${${s.variable}}; export it before starting ${who}`;
}
