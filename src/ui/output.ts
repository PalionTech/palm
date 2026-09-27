import pc from 'picocolors';
import type { InstallOutcome, InstallResult, Logger, Scope, TargetId } from '../core/types.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** Shorten `text` to at most `max` visible characters, ending with an ellipsis when cut. */
export function truncate(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Render rows as padded columns (two-space gutter). ANSI colour codes do not count toward widths. */
export function formatTable(rows: string[][], header?: string[]): string {
  const clean = (r: string[]) => r.map((c) => (c ?? '').replace(/\r?\n/g, ' '));
  const body = rows.map(clean);
  const head = header ? clean(header) : undefined;
  const all = head ? [head, ...body] : body;
  const cols = all.reduce((n, r) => Math.max(n, r.length), 0);
  if (cols === 0) return '';
  const widths = Array.from({ length: cols }, (_, i) => all.reduce((w, r) => Math.max(w, visibleWidth(r[i] ?? '')), 0));
  const line = (r: string[], style?: (s: string) => string) =>
    widths
      .map((w, i) => {
        const cell = r[i] ?? '';
        const padded = i === cols - 1 ? cell : padVisible(cell, w);
        return style ? style(padded) : padded;
      })
      .join('  ')
      .trimEnd();
  const out: string[] = [];
  if (head) {
    out.push(line(head, pc.bold));
    out.push(pc.dim(widths.map((w) => '─'.repeat(Math.max(w, 1))).join('  ')));
  }
  for (const r of body) out.push(line(r));
  return out.join('\n');
}

export function printTable(rows: string[][], header?: string[]): void {
  const text = formatTable(rows, header);
  if (text) console.log(text);
}

export function createLogger(opts: { verbose: boolean; json?: boolean }): Logger {
  const out = (msg: string) => (opts.json ? process.stderr : process.stdout).write(`${msg}\n`);
  const err = (msg: string) => process.stderr.write(`${msg}\n`);
  return {
    info: (msg) => out(msg),
    success: (msg) => out(`${pc.green('✓')} ${msg}`),
    warn: (msg) => err(pc.yellow(`⚠ ${msg}`)),
    debug: (msg) => {
      if (opts.verbose) err(pc.dim(`· ${msg}`));
    },
  };
}

function colourStatus(status: InstallOutcome['status']): string {
  switch (status) {
    case 'installed':
      return pc.green(status);
    case 'updated':
      return pc.cyan(status);
    case 'unchanged':
      return pc.dim(status);
    case 'skipped':
      return pc.yellow(status);
  }
}

function fileCount(o: InstallOutcome): string {
  const files = o.entry.files.length;
  const merged = o.entry.merged?.length ?? 0;
  return merged ? `${files} (+${merged} merged)` : String(files);
}

export function printInstallSummary(result: InstallResult, opts: { scope: Scope; targets: TargetId[] }): void {
  const targets = opts.targets.length ? opts.targets.join(', ') : 'no targets';
  if (result.outcomes.length === 0) {
    console.log(pc.dim(`Nothing to install (${opts.scope} scope → ${targets}).`));
  } else {
    console.log(`${pc.bold(opts.scope)} scope → ${pc.bold(targets)}`);
    printTable(
      result.outcomes.map((o) => [
        colourStatus(o.status),
        o.entry.kind,
        o.entry.via ? `${o.entry.name} ${pc.dim(`(${o.entry.via})`)}` : o.entry.name,
        o.entry.origin,
        o.entry.targets.join(','),
        fileCount(o),
      ]),
      ['status', 'kind', 'name', 'origin', 'targets', 'files'],
    );
    const tally = new Map<string, number>();
    for (const o of result.outcomes) tally.set(o.status, (tally.get(o.status) ?? 0) + 1);
    console.log(pc.dim([...tally].map(([s, n]) => `${n} ${s}`).join(', ')));
    const noted = result.outcomes.filter((o) => o.notes.length > 0);
    if (noted.length) {
      console.log('');
      for (const o of noted) for (const note of o.notes) console.log(`${pc.cyan('•')} ${pc.bold(o.entry.name)}: ${note}`);
    }
  }
  if (result.warnings.length) {
    console.log('');
    for (const w of result.warnings) console.log(pc.yellow(`⚠ ${w}`));
  }
}
