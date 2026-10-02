/**
 * Formatting shared by the consent prompt, the script viewer and the diff: sizes, modes and
 * text from a source made safe to print on a terminal.
 */

/** Code point ranges a terminal would act on or hide: C0/C1 controls, bidi, zero-width, BOM. */
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

const LINE_BREAKS = new Set([0x09, 0x0a]);

function isInvisible(code: number, keep: ReadonlySet<number>): boolean {
  return !keep.has(code) && INVISIBLE.some(([lo, hi]) => code >= lo && code <= hi);
}

function reveal(text: string, keep: ReadonlySet<number>): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += isInvisible(code, keep) ? `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return out;
}

/**
 * `text` with every control, bidi and zero-width character written as `<U+XXXX>`, so a name or
 * command from a source cannot move the cursor, recolour the prompt or hide a line in it.
 * Newlines and tabs are escaped too: one value, one line.
 */
export function visible(text: string): string {
  return reveal(text, new Set());
}

/** A script body made safe to print: as `visible`, but keeping newlines and tabs (CRLF read as LF). */
export function visibleBody(text: string): string {
  return reveal(text.replace(/\r\n/g, '\n'), LINE_BREAKS);
}

/** `612 B`, `1.1 KB`, `21 KB`, `3.4 MB`; `?` when unknown. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/** Permission bits as octal: `755`. */
export function modeText(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}
