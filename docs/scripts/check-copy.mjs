#!/usr/bin/env node
// Enforces the mechanical rules of docs/STYLE.md on every page in src/content/docs.
//
//   node scripts/check-copy.mjs
//
// Fails on: banned words, em dashes, exclamation marks and emoji in prose, and headings that are
// not sentence case. Code blocks and inline code are exempt, except from the em-dash rule.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(DOCS, 'src', 'content', 'docs');

const BANNED = [
  'leverag\\w*',
  'seamless\\w*',
  'robust\\w*',
  'delv\\w*',
  'empower\\w*',
  'streamlin\\w*',
  'unleash\\w*',
  'effortless\\w*',
  'cutting-edge',
  'game-changer',
  'supercharg\\w*',
  'revolutioni[sz]\\w*',
  'unlock\\w*',
  'elevat\\w*',
  'powerful',
  'blazing\\w*',
  'next-generation',
  'world-class',
  'comprehensive\\w*',
  'dive into',
  'journey\\w*',
  'landscape\\w*',
  "it's worth noting",
  'in order to',
  'magic\\w*',
  'simply',
  'just',
  'easy',
  'easily',
];
const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');

// Words that keep their capital in a sentence-case heading.
const PROPER = new Set(
  'palm Claude Code Codex GitHub Copilot Cursor Gemini CLI OpenCode MCP APM VS JSON TOML YAML Node Markdown Unicode OAuth CI npm git'.split(
    ' ',
  ),
);

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(abs);
    else if (/\.mdx?$/.test(entry.name)) yield abs;
  }
}

/** Prose lines with their line numbers: no code fences, imports, JSX-only lines or inline code. */
function* proseLines(text) {
  let fenced = false;
  for (const [i, raw] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^(import |export )/.test(raw)) continue;
    const line = raw.replace(/`[^`]*`/g, '``').replace(/<!--.*?-->/g, '');
    yield [i + 1, line];
  }
}

function headingProblem(line) {
  const m = /^#{1,6}\s+(.*)$/.exec(line) ?? /^title:\s*['"]?(.*?)['"]?$/.exec(line);
  if (!m) return undefined;
  const words = m[1].split(/\s+/).slice(1);
  const bad = words.filter((w) => {
    const word = w.replace(/[^\w.-]/g, '');
    return /^[A-Z][a-z]/.test(word) && !PROPER.has(word);
  });
  return bad.length ? `heading not in sentence case: ${bad.join(', ')}` : undefined;
}

function lineProblems(line) {
  const problems = [];
  const banned = BANNED_RE.exec(line);
  if (banned) problems.push(`banned word "${banned[0]}"`);
  if (/[\w)`]!(\s|$)/.test(line)) problems.push('exclamation mark');
  if (/\p{Extended_Pictographic}/u.test(line)) problems.push('emoji');
  const heading = headingProblem(line);
  if (heading) problems.push(heading);
  return problems;
}

function checkFile(file) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(DOCS, file);
  const out = [];
  for (const [n, line] of text.split('\n').entries()) {
    if (line.includes('—')) out.push(`${rel}:${n + 1}: em dash`);
  }
  for (const [n, line] of proseLines(text)) {
    for (const p of lineProblems(line)) out.push(`${rel}:${n}: ${p}`);
  }
  return out;
}

const problems = [...markdownFiles(CONTENT)].flatMap(checkFile);
if (problems.length) {
  process.stderr.write(`check-copy: ${problems.length} problem(s)\n${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('check-copy: all pages follow STYLE.md\n');
}
