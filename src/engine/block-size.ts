/**
 * Root instruction files palm writes blocks into (B2, Z6): Codex reads at most 32 KiB of
 * AGENTS.md, so a block that takes the file above the cap is refused for that target unless
 * `--force`, and a file above 24 KiB warns. Install and dry run use `refuseOversizedBlocks`
 * before anything is written; `check` uses `blockSizeProblem` on the files as they are.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { InstallFailure, RenderedFragment, TargetId } from '../core/types.js';
import { parseMergedRecord } from '../domain/merged-record.js';
import { upsertBlockText } from '../targets/managed-block.js';
import type { Run } from './jobs.js';
import type { RenderOutput } from './render.js';
import { failure, installCommand, type Subject } from './report.js';

/** Above this a root AGENTS.md or GEMINI.md block file warns. */
const BLOCK_WARN_BYTES = 24 * 1024;
/** Codex reads at most 32 KiB of AGENTS.md (`project_doc_max_bytes`). */
export const BLOCK_CAPS: Readonly<Record<string, number | undefined>> = {
  'AGENTS.md': 32 * 1024,
  'GEMINI.md': undefined,
};

/**
 * The verdict on a block file of `bytes` (install and dry run use it before writing, `check`
 * after): `fail` above the harness's cap (install refuses without `--force`), `warn` above
 * 24 KiB. The fix names `targets:` on the entry until `at:` ships in 0.3.
 */
export function blockSizeProblem(
  file: string,
  bytes: number,
): { level: 'fail' | 'warn'; message: string; fix: string } | undefined {
  const cap = BLOCK_CAPS[basename(file)];
  const size = `${file} is ${Math.round(bytes / 1024)} KiB`;
  const fix =
    'narrow the entries with targets: in palm.yaml (for example targets: [claude]) until at: arrives in palm 0.3';
  if (cap !== undefined && bytes > cap)
    return {
      level: 'fail',
      message: `${size}, above the ${cap / 1024} KiB the harness reads`,
      fix,
    };
  return bytes > BLOCK_WARN_BYTES ? { level: 'warn', message: size, fix } : undefined;
}

/** The text of `file` as this run will have written it so far (blocks of earlier entities included). */
const projected = new WeakMap<Run, Map<string, string | undefined>>();

async function textOf(run: Run, abs: string): Promise<string | undefined> {
  let texts = projected.get(run);
  if (!texts) {
    texts = new Map();
    projected.set(run, texts);
  }
  if (!texts.has(abs)) texts.set(abs, await readFile(abs, 'utf8').catch(() => undefined));
  return texts.get(abs);
}

/** The block file's size after this fragment; undefined when the fragment changes nothing. */
async function sizeAfter(run: Run, f: RenderedFragment): Promise<number | undefined> {
  if (!f.at.startsWith('block:') || !(basename(f.file) in BLOCK_CAPS)) return undefined;
  const rec = parseMergedRecord({ ...f, file: f.file });
  if (rec.type !== 'md-block') return undefined;
  const abs = run.state.paths.abs(f.file);
  const next = upsertBlockText(await textOf(run, abs), {
    file: abs,
    id: rec.key,
    content: rec.content,
  });
  if (next === undefined) return undefined;
  projected.get(run)?.set(abs, next);
  return Buffer.byteLength(next);
}

function refusal(run: Run, subject: Subject, id: TargetId, message: string, fix: string) {
  const again = installCommand(subject, run.state.paths.scope, '--force');
  return failure(
    subject,
    'E_TARGET',
    { message, hint: `${fix}; or write it anyway: ${again}` },
    id,
  );
}

/**
 * B2 Z6: each target whose block would take a root AGENTS.md above the harness's cap is left
 * out with a failure (unless `--force`); above 24 KiB the run warns. Only a block that changes
 * the file is measured, so an unchanged sync stays quiet.
 */
export async function refuseOversizedBlocks(
  run: Run,
  subject: Subject,
  out: RenderOutput,
): Promise<void> {
  const refused: InstallFailure[] = [];
  for (const [id, r] of Object.entries(out.renders) as Array<
    [TargetId, RenderOutput['renders'][TargetId]]
  >)
    for (const f of r?.fragments ?? []) {
      const bytes = await sizeAfter(run, f);
      const problem = bytes === undefined ? undefined : blockSizeProblem(f.file, bytes);
      if (!problem) continue;
      if (problem.level === 'fail' && !run.ctx.flags.force) {
        refused.push(refusal(run, subject, id, problem.message, problem.fix));
        delete out.renders[id];
      } else out.warnings.push(`${problem.message}; ${problem.fix}`);
    }
  out.refusals.push(...refused);
}
