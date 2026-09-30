#!/usr/bin/env node
// Refuses provider-shaped secret literals in tracked files. Test fixtures build such values at
// runtime from a prefix and a filler; a literal that matches a real provider pattern trips
// GitHub's secret scanning and must never be committed. Usage: node scripts/check-secrets.mjs
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

const PATTERNS = [
  ['Google API key', /(?<![0-9A-Za-z])AIza[0-9A-Za-z_-]{35}/],
  ['GitHub token', /gh[pousr]_[0-9A-Za-z]{36}/],
  ['GitHub fine-grained token', /github_pat_[0-9A-Za-z_]{40,}/],
  ['Slack token', /xox[abpr]-[0-9A-Za-z-]{10,}/],
  ['AWS access key', /(?<![0-9A-Za-z])AKIA[0-9A-Z]{16}/],
  ['OpenAI or Anthropic key', /(?<![0-9A-Za-z])sk-(?:proj-|ant-api\d\d-)?[0-9A-Za-z_-]{20,}/],
  ['GitLab token', /glpat-[0-9A-Za-z_-]{20}/],
  ['Stripe live key', /sk_live_[0-9A-Za-z]{24}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const SKIP = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|tgz|pdf)$/i;
const MAX_BYTES = 2_000_000;

/** A tracked file's text, read through one descriptor; undefined when too large or deleted. */
function readSmall(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return fstatSync(fd).size > MAX_BYTES ? undefined : readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const hits = [];
for (const file of files) {
  if (SKIP.test(file) || file === 'scripts/check-secrets.mjs') continue;
  const text = readSmall(file);
  if (text === undefined || text.includes('\0')) continue;
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${name}`);
  });
}
if (hits.length > 0) {
  console.error('x secret-shaped literal in a tracked file; build test values at runtime instead:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-secrets: ${files.length} tracked files, no provider-shaped literal`);
