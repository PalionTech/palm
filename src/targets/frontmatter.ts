import { stringify } from 'yaml';

/** Strip leading blank lines, end with exactly one newline (empty body stays empty). */
export function normalizeBody(body: string): string {
  const trimmed = body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  return trimmed === '' ? '' : trimmed + '\n';
}

/** YAML mapping text (no fences, no trailing newline); undefined values are skipped. */
export function yamlMapping(data: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length === 0) return '';
  return stringify(clean, { lineWidth: 0, minContentWidth: 0 }).replace(/\n+$/, '');
}

/** YAML scalar for a single string value, quoted only when YAML requires it. */
export function yamlScalar(value: string): string {
  return stringify(value, { lineWidth: 0, minContentWidth: 0 }).replace(/\n+$/, '');
}

/** `---\n<fm>\n---\n\n<body>`; plain body when `fm` is empty. */
export function withFrontmatter(fm: string, body: string): string {
  const b = normalizeBody(body);
  if (fm === '') return b;
  return `---\n${fm}\n---\n` + (b === '' ? '' : `\n${b}`);
}
