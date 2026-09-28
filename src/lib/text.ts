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

/** `word` for one, `word` + `s` for any other count (`secret`, `secrets`). */
export function pluralWord(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** The count and the word: `1 file`, `3 files`. */
export function plural(n: number, word: string): string {
  return `${n} ${pluralWord(n, word)}`;
}
