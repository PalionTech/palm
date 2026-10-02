/** Text normalisation shared by the JSON, YAML and frontmatter readers. */

/** A word a shell passes on as is (`#` starts a comment only at the start of a word). */
const SHELL_SAFE = /^[\w@%+=:,./-][\w@%+=:,./#-]*$/;

/** A word as it is typed in a shell: as is when safe, else single-quoted (a glob, a space). */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

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
function pluralWord(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** The count and the word: `1 file`, `3 files`. */
export function plural(n: number, word: string): string {
  return `${n} ${pluralWord(n, word)}`;
}

/** Levenshtein distance between `a` and `b` (insertions, deletions and substitutions cost 1). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(tmp + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * The candidate closest to `word` (any case) within `max` edits, or one that contains it or is
 * contained in it (`target` for `targets`); undefined when none is close.
 */
export function closestWord(
  word: string,
  candidates: Iterable<string>,
  max = 2,
): string | undefined {
  const q = word.toLowerCase();
  let best: { word: string; d: number } | undefined;
  for (const c of candidates) {
    const n = c.toLowerCase();
    const d = n.includes(q) || q.includes(n) ? Math.min(editDistance(q, n), 1) : editDistance(q, n);
    if (d <= max && (!best || d < best.d)) best = { word: c, d };
  }
  return best?.word;
}
