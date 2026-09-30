/**
 * `secrets` (DESIGN §6 "Check", §8): no literal secret in a harness config palm writes or
 * merges into, or in an MCP file it parses (including the files of targets a partial install
 * missed, Y5), when git tracks it, wherever its real path lies (a dotfiles link counts, J1), or
 * others can read it; a literal value under a secret-shaped env or header key counts even when
 * no shape rule recognises it (J1); a literal in palm.yaml's `mcp:` always fails. A literal in
 * a server is blamed on the entry that merged that server, found by its JSON pointer, and a
 * server no entry merged is called foreign (S6 J16'). `variables` lists, one warning line per
 * installed server, the variables it needs that are not set (K17 D20, S7). Nothing is
 * written; values are never printed.
 */
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckRun, LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { requiredSecretNames } from '../domain/secret-refs.js';
import { visible } from '../exec/format.js';
import { isGitTracked } from '../lib/fs.js';
import { formatPointer } from '../lib/json-pointer.js';
import { isRecord } from '../lib/object.js';
import { isFillIn, isSecretKey } from '../secrets/scan.js';
import { type McpFile, mcpFiles } from './check-harness.js';
import { type CheckContext, checkRun, count, entityOf, type Found, found } from './check-kit.js';
import { palmCommand } from './report.js';
import { readConfig } from './rotate.js';
import { referenceSecrets } from './source-secrets.js';

/** Keys whose object holds environment values or HTTP headers of a server (every harness's spelling). */
const VALUE_BLOCKS = new Set(['env', 'environment', 'headers', 'http_headers']);
const REFERENCE = /\$\{[^}]*\}|\{env:[^}]*\}|^\$[A-Za-z_][A-Za-z0-9_]*$/;

/** A value written as it is: no reference, no fill-in placeholder, not a path. */
function isLiteralValue(value: string): boolean {
  return (
    value.trim() !== '' &&
    !REFERENCE.test(value) &&
    !isFillIn(value.replace(/^(?:Bearer|Basic|Token)\s+/i, '')) &&
    !/^(?:\/|\.{1,2}\/|~\/)/.test(value)
  );
}

function join(where: string, key: string): string {
  return where.endsWith(':') ? `${where}${key}` : `${where}.${key}`;
}

/** Where a literal secret sits (`.cursor/mcp.json:mcpServers.docs.env.DOCS_API_KEY`); never its value. */
interface Hit {
  where: string;
}

/** J1: literal values under secret-shaped keys of env and header blocks, anywhere in `doc`. */
function literalValues(doc: unknown, where: string, out: Hit[] = []): Hit[] {
  if (!isRecord(doc)) return out;
  for (const [k, v] of Object.entries(doc)) {
    const at = join(where, k);
    if (VALUE_BLOCKS.has(k) && isRecord(v)) {
      for (const [name, value] of Object.entries(v))
        if (typeof value === 'string' && isSecretKey(name) && isLiteralValue(value))
          out.push({ where: join(at, name) });
    } else literalValues(v, at, out);
  }
  return out;
}

function findingsIn(c: CheckContext, doc: unknown, where: string): Hit[] {
  const all: Hit[] = [...c.run.deps.scanSecrets(doc, where), ...literalValues(doc, where)];
  const seen = new Set<string>();
  return all.filter((f) => !seen.has(f.where) && seen.add(f.where));
}

/** Harness configs palm writes or merges into, and the MCP files it parses (lock form). */
function configFiles(c: CheckContext): string[] {
  const out = new Set<string>();
  const add = (file: string) => {
    if (/\.(json|toml)$/.test(file)) out.add(file);
  };
  for (const e of c.run.state.lock.entries) {
    for (const file of [...e.files, ...(e.merged ?? []).map((m) => m.file)]) add(file);
    for (const r of Object.values(c.renders.get(lockId(e))?.renders ?? {}))
      for (const g of r?.fragments ?? []) add(g.file);
  }
  for (const f of mcpFiles(c)) add(f.file);
  return [...out].sort();
}

/** Why a file with a literal is a problem: git tracks its real path, or others can read it. */
async function exposure(abs: string): Promise<string | undefined> {
  const real = await realpath(abs).catch(() => undefined);
  if (!real) return undefined;
  if (await isGitTracked(real, dirname(real)))
    return real === abs ? 'tracked by git' : `tracked by git (${real})`;
  const mode = await stat(real).then(
    (s) => s.mode,
    () => 0,
  );
  return mode & 0o004 ? 'readable by others' : undefined;
}

/** Literals found in one part of a file, with the entry that owns that part (none: foreign or shared). */
interface Part {
  hits: Hit[];
  owner?: LockEntry;
  /** A server no entry merged there. */
  foreign?: string;
}

/** The entry that merged `file#at`, if any. */
function ownerAt(c: CheckContext, file: string, at: string): LockEntry | undefined {
  return c.run.state.lock.entries.find((e) =>
    (e.merged ?? []).some((m) => m.file === file && m.at === at),
  );
}

/** S6 J16': the file's servers one by one, each with its owner; the rest of the file as one part. */
function partsOf(c: CheckContext, file: string, doc: unknown, mcp?: McpFile): Part[] {
  if (!mcp || !isRecord(doc)) return [{ hits: findingsIn(c, doc, file) }];
  let map: unknown = doc;
  for (const segment of mcp.path) map = isRecord(map) ? map[segment] : undefined;
  if (!isRecord(map)) return [{ hits: findingsIn(c, doc, file) }];
  const parts: Part[] = Object.entries(map).map(([name, server]) => {
    const hits = findingsIn(c, server, `${file}:${[...mcp.path, name].join('.')}`);
    const owner = ownerAt(c, file, formatPointer([...mcp.path, name]));
    return owner ? { hits, owner } : { hits, foreign: name };
  });
  const rest = structuredClone(doc) as Record<string, unknown>;
  let parent: unknown = rest;
  for (const segment of mcp.path.slice(0, -1)) parent = isRecord(parent) ? parent[segment] : {};
  if (isRecord(parent)) delete parent[mcp.path.at(-1) as string];
  return [...parts, { hits: findingsIn(c, rest, file) }];
}

function literalProblem(file: string, part: Part, why: string, scope: 'project' | 'global') {
  const where = part.hits.map((x) => x.where).join(', ');
  const fix = part.foreign
    ? `write a \${VAR} reference in ${file} instead, then rotate the value (palm does not manage server ${visible(part.foreign)})`
    : `write a \${VAR} reference instead (${palmCommand('install', [], scope, '--secrets env-ref')} for palm's servers), then rotate the value`;
  const who = part.foreign ? `foreign server ${visible(part.foreign)} in ` : '';
  const message = `${who}${file} holds a literal secret (${where}), ${why}`;
  return part.owner ? { entity: entityOf(part.owner), file, message, fix } : { file, message, fix };
}

async function fileLiterals(c: CheckContext, f: Found): Promise<void> {
  const { paths } = c.run.state;
  const mcp = new Map(mcpFiles(c).map((m) => [m.file, m]));
  for (const file of configFiles(c)) {
    const abs = paths.abs(file);
    const parts = partsOf(c, file, await readConfig(abs), mcp.get(file)).filter(
      (p) => p.hits.length,
    );
    if (!parts.length) continue;
    const why = await exposure(abs);
    if (why) for (const p of parts) f.fail.push(literalProblem(file, p, why, paths.scope));
  }
}

/** A literal secret in palm.yaml `mcp:` always fails: palm.yaml is committed. */
function manifestLiterals(c: CheckContext, f: Found): void {
  const findings = findingsIn(c, c.run.state.manifest.mcp, 'palm.yaml:mcp');
  if (!findings.length) return;
  f.fail.push({
    file: 'palm.yaml',
    message: `palm.yaml holds a literal secret (${findings.map((x) => x.where).join(', ')})`,
    fix: `edit palm.yaml: write \${VAR} instead of the value, export VAR, and rotate the value`,
  });
}

/** No literal secret in a tracked or world-readable harness config or in palm.yaml. */
export async function secrets(c: CheckContext): Promise<CheckRun> {
  const f = found();
  await fileLiterals(c, f);
  manifestLiterals(c, f);
  return checkRun(
    'secrets',
    {
      ok: 'no literal secret in generated files',
      bad: (n) => `${count(n, 'secret problem')}`,
    },
    f,
  );
}

/**
 * The variables a server needs, as it renders: a literal the source shipped is written as a
 * `${VAR}` reference (ruling 5), so it is a variable the server needs too (S7).
 */
function neededBy(c: CheckContext, e: LockEntry): string[] {
  const entity = e.kind === 'mcp' ? c.renders.get(lockId(e))?.entity : undefined;
  if (entity?.def.kind !== 'mcp') return [];
  const { entity: referenced } = referenceSecrets(entity);
  return referenced.def.kind === 'mcp' ? [...requiredSecretNames(referenced.def.mcp)] : [];
}

/** K17 D20 S7: one warning line per installed server with the required variables that are not set. */
export function variables(c: CheckContext): CheckRun {
  const f = found();
  const set = new Set<string>();
  for (const e of c.run.state.lock.entries) {
    const names = neededBy(c, e);
    const unset = names.filter((n) => !c.run.ctx.env[n]);
    for (const n of names) if (c.run.ctx.env[n]) set.add(n);
    if (!unset.length) continue;
    f.warn.push({
      entity: entityOf(e),
      message: `needs ${unset.join(', ')}, ${unset.length === 1 ? 'which is' : 'which are'} not set`,
      fix: `export ${unset.map((n) => `${n}=…`).join(' ')}`,
    });
  }
  const names = [...set].sort();
  return checkRun(
    'variables',
    {
      ok: names.length
        ? `every variable the servers need is set (${names.join(', ')})`
        : 'every variable the servers need is set',
      bad: (n) => `${count(n, 'server needs', 'servers need')} variables that are not set`,
    },
    f,
  );
}
