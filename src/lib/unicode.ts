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

/**
 * Cheap pre-check, a superset of what `hiddenUnicodeSeverity` reports (format characters, the
 * invisible fillers, tag characters, supplementary variation selectors): most text contains none
 * of these, and the native regex spares it the per-code-point scan. test/lib/unicode checks the
 * superset property over the planes where such characters live.
 */
export const MAY_HIDE_UNICODE =
  /[\p{Cf}\u115f\u1160\u3164\uffa0\u{E0000}-\u{E007F}]|\u034f|[\u{E0100}-\u{E01EF}]/u;

/** Severity of `cp` by itself, ignoring its position; undefined for ordinary characters. */
export function hiddenUnicodeSeverity(cp: number): HiddenUnicodeSeverity | undefined {
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
  if (!MAY_HIDE_UNICODE.test(text)) return [];
  const points = codePointsOf(text);
  const cps = points.map((p) => p.cp);
  const findings: HiddenUnicodeFinding[] = [];
  points.forEach(({ cp, index }, i) => {
    const severity = hiddenUnicodeSeverity(cp);
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

// ---------------------------------------------------------------------------------------------
// Display width: how many terminal columns text takes (string-width's rules, no dependency).

const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** `text` without ANSI colour (SGR) sequences. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_RE, '');
}

/** Graphemes that take no column: controls, format and default-ignorable characters, lone marks. */
const ZERO_WIDTH_RE =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+$/u;
/** Unicode sets mode: `\p{RGI_Emoji}` needs it, and the ES2022 target cannot spell `/…/v`. */
const SETS_FLAG = 'v';
/** A fully qualified emoji (sequences included), built at run time for the `v` flag. */
const RGI_EMOJI_RE = new RegExp('^\\p{RGI_Emoji}$', SETS_FLAG);
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}/u;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

/** East Asian Wide and Fullwidth blocks (UAX #11) outside the emoji, sorted, inclusive. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation (U+3000 included)
  [0x3041, 0x33ff], // Kana, Bopomofo, Hangul compatibility Jamo, enclosed CJK, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth ASCII variants
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x16fe4], // ideographic symbols
  [0x17000, 0x18cff], // Tangut, Khitan
  [0x1aff0, 0x1b2ff], // Kana supplements, Nushu
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x3fffd], // CJK extensions B and later (planes 2 and 3)
];

function isWide(cp: number): boolean {
  return WIDE.some(([from, to]) => cp >= from && cp <= to);
}

let segmenter: Intl.Segmenter | undefined;

/** User-perceived characters of `text` (Intl grapheme clusters). */
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Columns one grapheme cluster takes: 0, 1, or 2 (emoji, East Asian Wide/Fullwidth). */
function graphemeWidth(g: string): number {
  if (ZERO_WIDTH_RE.test(g)) return 0;
  if (RGI_EMOJI_RE.test(g) || EMOJI_PRESENTATION_RE.test(g)) return 2;
  for (const ch of g) {
    if (ZERO_WIDTH_RE.test(ch)) continue;
    return isWide(ch.codePointAt(0) as number) ? 2 : 1;
  }
  return 0;
}

/**
 * Terminal columns `text` takes: ANSI colour codes count 0, East Asian Wide/Fullwidth characters
 * and emoji (sequences included) 2, combining marks, joiners and variation selectors 0.
 */
export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  if (PRINTABLE_ASCII_RE.test(plain)) return plain.length;
  let width = 0;
  for (const g of graphemes(plain)) width += graphemeWidth(g);
  return width;
}

/**
 * The longest prefix of `text` (plain, no ANSI codes) at most `width` columns wide, cut between
 * grapheme clusters, so a wide character or an emoji sequence is never split.
 */
export function sliceToWidth(text: string, width: number): string {
  if (PRINTABLE_ASCII_RE.test(text)) return text.slice(0, Math.max(0, width));
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width) break;
    out += g;
    used += w;
  }
  return out;
}
