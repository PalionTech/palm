/**
 * Hidden-Unicode detection: characters that render as nothing (or reorder what is shown) but still
 * reach a model reading the file. Critical findings can hide or smuggle instructions (bidi
 * overrides, tag characters, supplementary variation selectors); warnings are invisible characters
 * with legitimate uses that are still worth a look.
 */

export type HiddenUnicodeSeverity = 'critical' | 'warning';

export interface HiddenUnicodeFinding {
  severity: HiddenUnicodeSeverity;
  codePoint: number;
  /** UTF-16 offset into the scanned text (what `text.slice` uses). */
  index: number;
  /** Unicode character name, e.g. `RIGHT-TO-LEFT OVERRIDE`. */
  name: string;
}

export interface StripHiddenUnicodeOptions {
  /** Lowest severity removed: `'warning'` (default) removes every finding, `'critical'` only critical ones. */
  severity?: HiddenUnicodeSeverity;
}

const BOM = 0xfeff;
const ZWJ = 0x200d;

const NAMES: ReadonlyMap<number, string> = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x115f, 'HANGUL CHOSEONG FILLER'],
  [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x206a, 'INHIBIT SYMMETRIC SWAPPING'],
  [0x206b, 'ACTIVATE SYMMETRIC SWAPPING'],
  [0x206c, 'INHIBIT ARABIC FORM SHAPING'],
  [0x206d, 'ACTIVATE ARABIC FORM SHAPING'],
  [0x206e, 'NATIONAL DIGIT SHAPES'],
  [0x206f, 'NOMINAL DIGIT SHAPES'],
  [0x3164, 'HANGUL FILLER'],
  [BOM, 'ZERO WIDTH NO-BREAK SPACE'],
  [0xffa0, 'HALFWIDTH HANGUL FILLER'],
  [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'],
  [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
  [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
  [0x1bca0, 'SHORTHAND FORMAT LETTER OVERLAP'],
  [0x1bca1, 'SHORTHAND FORMAT CONTINUING OVERLAP'],
  [0x1bca2, 'SHORTHAND FORMAT DOWN STEP'],
  [0x1bca3, 'SHORTHAND FORMAT UP STEP'],
  [0xe0001, 'LANGUAGE TAG'],
  [0xe0020, 'TAG SPACE'],
  [0xe007f, 'CANCEL TAG'],
]);

/** Invisible characters outside category Cf (fillers and joiners abused as blank identifiers). */
const EXTRA_INVISIBLE: ReadonlySet<number> = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);

/**
 * Cf characters that render a visible glyph (prepended concatenation marks such as the Arabic
 * number sign); they are not hidden, so they are not reported.
 */
const VISIBLE_FORMAT: ReadonlySet<number> = new Set([
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd,
  0x110cd,
]);

const FORMAT_RE = /^\p{Cf}$/u;
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u;

function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

function isSupplementaryVariationSelector(cp: number): boolean {
  return cp >= 0xe0100 && cp <= 0xe01ef;
}

function isBidiControl(cp: number): boolean {
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/** Severity of `cp` by itself, ignoring its position; undefined for ordinary characters. */
function classify(cp: number): HiddenUnicodeSeverity | undefined {
  if (isBidiControl(cp) || isTag(cp) || isSupplementaryVariationSelector(cp)) return 'critical';
  if (EXTRA_INVISIBLE.has(cp)) return 'warning';
  if (VISIBLE_FORMAT.has(cp)) return undefined;
  return FORMAT_RE.test(String.fromCodePoint(cp)) ? 'warning' : undefined;
}

function tagName(cp: number): string {
  const ch = String.fromCodePoint(cp - 0xe0000);
  if (/[A-Z]/.test(ch)) return `TAG LATIN CAPITAL LETTER ${ch}`;
  if (/[a-z]/.test(ch)) return `TAG LATIN SMALL LETTER ${ch.toUpperCase()}`;
  if (/[0-9]/.test(ch)) return `TAG DIGIT ${ch}`;
  return `TAG ${JSON.stringify(ch)}`;
}

/** Unicode name of `cp` for the characters this module reports; `FORMAT CHARACTER` otherwise. */
export function codePointName(cp: number): string {
  const known = NAMES.get(cp);
  if (known !== undefined) return known;
  if (isSupplementaryVariationSelector(cp)) return `VARIATION SELECTOR-${cp - 0xe0100 + 17}`;
  if (cp > 0xe0020 && cp < 0xe007f) return tagName(cp);
  if (isTag(cp)) return 'TAG CHARACTER';
  return 'FORMAT CHARACTER';
}

/** `U+XXXX NAME`, e.g. `U+202E RIGHT-TO-LEFT OVERRIDE`. */
export function describeCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${codePointName(cp)}`;
}

/** Skin-tone modifiers and emoji presentation selectors may sit between an emoji and a ZWJ. */
function isEmojiModifier(cp: number): boolean {
  return cp === 0xfe0f || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

function isPictographic(cp: number | undefined): boolean {
  return cp !== undefined && PICTOGRAPHIC_RE.test(String.fromCodePoint(cp));
}

/** A ZWJ inside an emoji sequence (👨‍👩‍👧) is how the emoji is spelled, not a hidden character. */
function isEmojiJoiner(cps: readonly number[], i: number): boolean {
  let prev = i - 1;
  while (prev >= 0 && isEmojiModifier(cps[prev] as number)) prev--;
  return isPictographic(cps[prev]) && isPictographic(cps[i + 1]);
}

interface CodePointAt {
  cp: number;
  index: number;
}

function codePointsOf(text: string): CodePointAt[] {
  const out: CodePointAt[] = [];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    out.push({ cp, index });
    index += ch.length;
  }
  return out;
}

/**
 * Every hidden character in `text`, in order. A BOM at offset 0 is allowed; anywhere else it is a
 * warning. A ZWJ joining two emoji is not reported.
 */
export function scanHiddenUnicode(text: string): HiddenUnicodeFinding[] {
  const points = codePointsOf(text);
  const cps = points.map((p) => p.cp);
  const findings: HiddenUnicodeFinding[] = [];
  points.forEach(({ cp, index }, i) => {
    const severity = classify(cp);
    if (severity === undefined) return;
    if (cp === BOM && index === 0) return;
    if (cp === ZWJ && isEmojiJoiner(cps, i)) return;
    findings.push({ severity, codePoint: cp, index, name: codePointName(cp) });
  });
  return findings;
}

/** True when `text` has at least one finding of `severity` or worse (default: any finding). */
export function hasHiddenUnicode(
  text: string,
  severity: HiddenUnicodeSeverity = 'warning',
): boolean {
  return scanHiddenUnicode(text).some((f) => severity === 'warning' || f.severity === 'critical');
}

/**
 * `text` without the characters `scanHiddenUnicode` reports (at or above `opts.severity`,
 * default every finding). Everything else, including a leading BOM, is kept as is.
 */
export function stripHiddenUnicode(text: string, opts: StripHiddenUnicodeOptions = {}): string {
  const onlyCritical = opts.severity === 'critical';
  const drop = scanHiddenUnicode(text).filter((f) => !onlyCritical || f.severity === 'critical');
  if (drop.length === 0) return text;
  let out = '';
  let from = 0;
  for (const f of drop) {
    out += text.slice(from, f.index);
    from = f.index + String.fromCodePoint(f.codePoint).length;
  }
  return out + text.slice(from);
}
