/** Text normalisation shared by the JSON, YAML and frontmatter readers. */

/** `text` without a leading byte-order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `text` without a leading BOM and with CRLF and lone CR line endings turned into LF. */
export function normalizeText(text: string): string {
  const t = stripBom(text);
  return t.includes('\r') ? t.replace(/\r\n?/g, '\n') : t;
}

/**
 * Shannon entropy of `s` in bits per character (code points), 0 for an empty string. Random
 * tokens score above 3.5; words and repeated characters score low.
 */
export function entropyBitsPerChar(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** `word` for one, `word` + `s` for any other count (`secret`, `secrets`). */
export function pluralWord(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** The count and the word: `1 file`, `3 files`. */
export function plural(n: number, word: string): string {
  return `${n} ${pluralWord(n, word)}`;
}
