/**
 * The rotate message (DESIGN §8): when an install replaces a literal secret palm finds under a
 * server's key in a harness file it owns, it says the old value may live on (git history, plain
 * text) and should be rotated.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import type { RenderedFragment, SecretFinding, TargetId } from '../core/types.js';
import { isGitTracked } from '../lib/fs.js';
import { parseJson } from '../lib/json.js';
import { findPlaceholders, isRuntimeVar } from '../lib/placeholders.js';
import type { Prepared, Run } from './jobs.js';

/** A generated JSON or TOML file, parsed; undefined when missing or unreadable. */
export async function readConfig(abs: string): Promise<unknown> {
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    if (abs.endsWith('.toml')) return parseToml(text);
    if (abs.endsWith('.json')) return parseJson(text, { tolerant: true });
  } catch {
    return undefined;
  }
  return undefined;
}

/** The MCP fragments of the render, by file, with the targets that write them. */
function serverFiles(
  p: Prepared,
): Map<string, { fragment: RenderedFragment; targets: TargetId[] }> {
  const out = new Map<string, { fragment: RenderedFragment; targets: TargetId[] }>();
  if (p.job.entity.kind !== 'mcp') return out;
  for (const [id, r] of Object.entries(p.out.renders))
    for (const f of r?.fragments ?? []) {
      const seen = out.get(f.file);
      if (seen) seen.targets.push(id as TargetId);
      else out.set(f.file, { fragment: f, targets: [id as TargetId] });
    }
  return out;
}

async function literalsIn(run: Run, file: string, server: string): Promise<SecretFinding[]> {
  const doc = await readConfig(run.state.paths.abs(file));
  if (doc === undefined) return [];
  return run.deps.scanSecrets(doc, file).filter((f) => f.where.includes(server));
}

/** Literal secrets under the server's key in the files the entity owns, before it is written. */
export async function literalsBefore(run: Run, p: Prepared): Promise<Map<string, SecretFinding[]>> {
  const out = new Map<string, SecretFinding[]>();
  if (run.ctx.flags.dryRun || !p.previous) return out;
  for (const file of serverFiles(p).keys()) {
    const found = await literalsIn(run, file, p.job.entity.name);
    if (found.length) out.set(file, found);
  }
  return out;
}

function variableOf(fragment: RenderedFragment): string | undefined {
  return findPlaceholders(JSON.stringify(fragment.value)).find((v) => !isRuntimeVar(v.name))?.name;
}

/** After the write: one rotate warning per literal that is gone from a file palm rewrote. */
export async function rotationWarnings(
  run: Run,
  p: Prepared,
  before: Map<string, SecretFinding[]>,
): Promise<void> {
  if (!before.size) return;
  const { rotateMessage } = await import('../secrets/policy.js');
  const files = serverFiles(p);
  for (const [file, found] of before) {
    const after = await literalsIn(run, file, p.job.entity.name);
    const written = files.get(file);
    const variable = written ? variableOf(written.fragment) : undefined;
    if (!written || !variable) continue;
    const tracked = (await isGitTracked(run.state.paths.abs(file), run.state.paths.root)) ?? false;
    const harnesses = written.targets.map((t) => run.deps.getTarget(t).displayName);
    for (const f of found.filter((x) => !after.some((a) => a.where === x.where)))
      run.result.warnings.push(
        rotateMessage({
          server: p.job.entity.name,
          file,
          key: f.key ?? f.where,
          variable,
          tracked,
          harnesses,
        }),
      );
  }
}
