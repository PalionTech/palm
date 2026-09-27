import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa, parseCommandString } from 'execa';
import pc from 'picocolors';
import { stringify } from 'yaml';
import { PalmError } from '../core/errors.js';
import type { InstallRequest, InstallResult, Kind, OriginSpec, PalmContext, Scope, TargetId, UI } from '../core/types.js';
import { printInstallSummary } from '../ui/output.js';
import { supportsMultiline } from '../ui/prompts.js';

/** Options every `create*` wizard accepts (API.md plus the optional `targets` extension). */
export interface CreateOptions {
  name?: string;
  /** false = never install; true = install without asking; undefined = ask (default yes). */
  install?: boolean;
  scope: Scope;
  /** --target flag, forwarded to resolveTargets. */
  targets?: TargetId[];
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateSlug(value: string): string | undefined {
  if (!value.trim()) return 'a name is required';
  if (!SLUG_RE.test(value.trim())) return 'use lowercase letters, digits and single hyphens (e.g. code-reviewer)';
  return undefined;
}

export function required(what: string): (v: string) => string | undefined {
  return (v) => (v.trim() ? undefined : `${what} is required`);
}

/** Remove `<!-- … -->` comments (single or multi-line) and tidy the blank lines they leave behind. */
export function stripHtmlComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render `---\n<yaml>\n---\n\n<body>\n`. Keys with undefined values are omitted. */
export function renderFrontmatterFile(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const yaml = stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

export function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

function editorCommand(ctx: PalmContext): string | undefined {
  const e = (ctx.env.VISUAL || ctx.env.EDITOR || '').trim();
  return e || undefined;
}

export function canUseEditor(ctx: PalmContext): boolean {
  return ctx.ui.isInteractive && editorCommand(ctx) !== undefined;
}

/** Open `file` in $VISUAL/$EDITOR and wait. Returns false when no editor is configured. */
export async function openInEditor(ctx: PalmContext, file: string): Promise<boolean> {
  const cmd = editorCommand(ctx);
  if (!cmd || !ctx.ui.isInteractive) return false;
  const [bin, ...args] = parseCommandString(cmd);
  if (!bin) return false;
  try {
    await execa(bin, [...args, file], { stdio: 'inherit' });
  } catch (e) {
    throw new PalmError('E_IO', `editor "${cmd}" failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, 'check $VISUAL / $EDITOR');
  }
  return true;
}

/**
 * Ask for a long text. With an editor: write `template` (HTML comments are instructions) to a
 * temp .md, open it, read it back and strip comments. Otherwise a multi-line (or plain) text prompt.
 */
export async function editBody(ctx: PalmContext, opts: { template: string; message: string; placeholder?: string }): Promise<string> {
  if (canUseEditor(ctx)) {
    const dir = await mkdtemp(join(tmpdir(), 'palm-edit-'));
    const file = join(dir, 'body.md');
    try {
      await writeFile(file, opts.template);
      ctx.log.info(pc.dim(`opening ${editorCommand(ctx)} — save and close to continue`));
      await openInEditor(ctx, file);
      const text = stripHtmlComments(await readFile(file, 'utf8'));
      if (text) return text;
      ctx.log.warn('the editor returned an empty text; please type it instead');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return promptLongText(ctx.ui, opts.message, opts.placeholder);
}

export async function promptLongText(ui: UI, message: string, placeholder?: string): Promise<string> {
  if (supportsMultiline(ui)) return (await ui.multiline(message, { placeholder })).trim();
  return (await ui.text(message, { placeholder, validate: required('text') })).trim();
}

export async function mineDir(ctx: PalmContext): Promise<{ mine: OriginSpec; dir: string }> {
  const { ensureMineOrigin } = await import('../core/config.js');
  const mine = await ensureMineOrigin(ctx);
  if (!mine.path) throw new PalmError('E_INTERNAL', 'the "mine" origin has no local path');
  return { mine, dir: mine.path };
}

/**
 * Write a new file into the mine origin. An existing file is only replaced after confirmation
 * (or with --force). Under --dry-run the content is printed instead. Returns false when skipped.
 */
export async function writeNewFile(ctx: PalmContext, file: string, content: string): Promise<boolean> {
  if (ctx.flags.dryRun) {
    ctx.log.info(`${pc.dim('would write')} ${file}\n${pc.dim('─'.repeat(40))}\n${content}${pc.dim('─'.repeat(40))}`);
    return false;
  }
  const existing = await stat(file).catch(() => undefined);
  if (existing && !ctx.flags.force) {
    const ok = ctx.ui.isInteractive ? await ctx.ui.confirm(`${file} exists. Overwrite it?`, false) : false;
    if (!ok) throw new PalmError('E_CONFLICT', `${file} already exists`, 'pick another name, or pass --force to overwrite');
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return true;
}

/** Rescan mine, then (optionally) install the new entity through the normal install path. */
export async function finishCreate(
  ctx: PalmContext,
  opts: CreateOptions & { kind: Kind; entityName: string; mine: OriginSpec; extra?: InstallRequest[] },
): Promise<void> {
  if (ctx.flags.dryRun) return;
  const { invalidateIndex } = await import('../core/cache.js');
  await invalidateIndex(ctx, opts.mine);

  let install = opts.install;
  if (install === undefined) install = ctx.ui.isInteractive && !ctx.flags.yes ? await ctx.ui.confirm(`Install ${opts.kind} ${opts.entityName} now?`, true) : true;
  const extraHint = (opts.extra ?? []).map((r) => ` ${typeof r.spec === 'string' ? r.spec : `${r.spec.name}${r.spec.origin ? `@${r.spec.origin}` : ''}`}`).join('');
  if (!install) {
    ctx.log.info(`${pc.dim('install later with:')} palm install ${opts.kind} ${opts.entityName}@${opts.mine.alias}${opts.scope === 'global' ? ' -g' : ''}`);
    if (extraHint) ctx.log.info(`${pc.dim('and:')} palm install instructions${extraHint}`);
    return;
  }

  const { resolveTargets } = await import('../engine/resolve-targets.js');
  const { installEntities } = await import('../engine/install.js');
  const targets: TargetId[] = await resolveTargets(ctx, { scope: opts.scope, flag: opts.targets, save: true });
  const requests: InstallRequest[] = [{ kind: opts.kind, spec: { name: opts.entityName, origin: opts.mine.alias } }, ...(opts.extra ?? [])];
  const result: InstallResult = await installEntities(ctx, requests, { scope: opts.scope, targets });
  printInstallSummary(result, { scope: opts.scope, targets });
}
