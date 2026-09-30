/**
 * `secrets` (DESIGN §6 "Check", §8): no literal secret in a harness config palm writes or
 * merges into (including the files of targets a partial install missed, Y5) when git tracks it,
 * wherever its real path lies (a dotfiles link counts, J1), or others can read it; a literal
 * value under a secret-shaped env or header key counts even when no shape rule recognises it
 * (J1); a literal in palm.yaml's `mcp:` always fails. Variables the servers need that are not
 * set are one warning line per server (K17 D20). Nothing is written; values are never printed.
 */
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckProblem, CheckRun, LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { requiredSecretNames } from '../domain/secret-refs.js';
import { isGitTracked } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { isSecretKey } from '../secrets/scan.js';
import { isFillIn } from '../secrets/typed.js';
import { type CheckContext, checkRun, count, entityOf, type Found, found } from './check-kit.js';
import { palmCommand } from './report.js';
import { readConfig } from './rotate.js';

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

/** Harness configs palm writes or merges into, with an entry that owns each (first seen). */
function configFiles(c: CheckContext): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  const add = (file: string, e: LockEntry) => {
    if (/\.(json|toml)$/.test(file) && !out.has(file)) out.set(file, e);
  };
  for (const e of c.run.state.lock.entries) {
    for (const file of [...e.files, ...(e.merged ?? []).map((m) => m.file)]) add(file, e);
    for (const r of Object.values(c.renders.get(lockId(e))?.renders ?? {}))
      for (const g of r?.fragments ?? []) add(g.file, e);
  }
  return out;
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

async function fileLiterals(c: CheckContext, f: Found): Promise<void> {
  const { paths } = c.run.state;
  for (const [file, owner] of configFiles(c)) {
    const abs = paths.abs(file);
    const findings = findingsIn(c, await readConfig(abs), file);
    if (!findings.length) continue;
    const why = await exposure(abs);
    if (!why) continue;
    const where = findings.map((x) => x.where).join(', ');
    f.fail.push({
      entity: entityOf(owner),
      file,
      message: `${file} holds a literal secret (${where}), ${why}`,
      fix: `write a \${VAR} reference instead (${palmCommand('install', [], paths.scope, '--secrets env-ref')} for palm's servers), then rotate the value`,
    });
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

/** K17 D20: one line per server with the required variables that are not set. */
function variables(c: CheckContext, f: Found): string[] {
  const set = new Set<string>();
  for (const e of c.run.state.lock.entries) {
    const entity = e.kind === 'mcp' ? c.renders.get(lockId(e))?.entity : undefined;
    if (entity?.def.kind !== 'mcp') continue;
    const names = [...requiredSecretNames(entity.def.mcp)];
    const unset = names.filter((n) => !c.run.ctx.env[n]);
    for (const n of names) if (c.run.ctx.env[n]) set.add(n);
    if (!unset.length) continue;
    const problem: CheckProblem = {
      entity: entityOf(e),
      message: `needs ${unset.join(', ')}, ${unset.length === 1 ? 'which is' : 'which are'} not set`,
      fix: `export ${unset.map((n) => `${n}=…`).join(' ')}`,
    };
    f.warn.push(problem);
  }
  return [...set].sort();
}

/** No literal secret in a tracked or world-readable harness config or in palm.yaml; variables listed. */
export async function secrets(c: CheckContext): Promise<CheckRun> {
  const f = found();
  await fileLiterals(c, f);
  manifestLiterals(c, f);
  const set = variables(c, f);
  const needs = set.length ? `; ${set.join(', ')} set` : '';
  return checkRun(
    'secrets',
    {
      ok: `no literal secret in generated files${needs}`,
      bad: (n) => `${count(n, 'secret problem')}${needs}`,
      warned: (n) =>
        `no literal secret in generated files; ${count(n, 'server needs', 'servers need')} variables that are not set`,
    },
    f,
  );
}
