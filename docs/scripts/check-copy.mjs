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

const COMMENT_OPEN = '<!--';
/** Where an HTML comment ends: `-->`, or `--!>` as browsers also accept. */
const COMMENT_CLOSE = /--!?>/;

/**
 * `line` without its HTML comments, scanned left to right, so no `<!--` survives and a comment may
 * span lines: `open` says a comment runs into the line, and the result says one runs past it.
 */
function withoutComments(line, open) {
  let prose = '';
  let rest = line;
  let inComment = open;
  for (;;) {
    if (inComment) {
      const close = COMMENT_CLOSE.exec(rest);
      if (!close) return { prose, open: true };
      rest = rest.slice(close.index + close[0].length);
      inComment = false;
    } else {
      const start = rest.indexOf(COMMENT_OPEN);
      if (start < 0) return { prose: prose + rest, open: false };
      prose += rest.slice(0, start);
      rest = rest.slice(start + COMMENT_OPEN.length);
      inComment = true;
    }
  }
}

/** Prose lines with their line numbers: no code fences, imports, comments or inline code. */
function* proseLines(text) {
  let fenced = false;
  let comment = false;
  for (const [i, raw] of text.split('\n').entries()) {
    if (!comment && /^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || (!comment && /^(import |export )/.test(raw))) continue;
    const stripped = withoutComments(raw.replace(/`[^`]*`/g, '``'), comment);
    comment = stripped.open;
    yield [i + 1, stripped.prose];
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
