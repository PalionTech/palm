#!/usr/bin/env node
// Function-shape check for src/: every function, method, accessor, constructor and arrow is
// measured with the TypeScript AST and reported when it has
//   - a body longer than 60 lines (blank and comment-only lines excluded),
//   - more than 4 parameters, or
//   - control-flow nesting deeper than 4 (if/else-if chains count once; nested functions
//     are measured on their own).
// Violations are counted per file and compared with scripts/shape-baseline.json; the check
// fails when any file has more than its baseline. The baseline may only go down.
//
//   node scripts/check-shape.mjs            check against the baseline
//   node scripts/check-shape.mjs --list     also print every violation
//   node scripts/check-shape.mjs --top 20   print the 20 largest offenders
//   node scripts/check-shape.mjs --update   rewrite the baseline (refuses to raise a count)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)('typescript');
const baselinePath = join(root, 'scripts', 'shape-baseline.json');
const LIMITS = { lines: 60, params: 4, depth: 4 };
const args = process.argv.slice(2);
const topIndex = args.indexOf('--top');
const top = topIndex >= 0 ? Number(args[topIndex + 1] ?? 20) : 0;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return walk(abs);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [abs] : [];
  });

const NESTING = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);

/** Lines of `node` that hold at least one token (so blank and comment-only lines drop out). */
function codeLines(node, sf) {
  const lines = new Set();
  const visit = (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0 && n.kind !== ts.SyntaxKind.SyntaxList) {
      const from = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const to = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
      for (let l = from; l <= to; l++) lines.add(l);
    }
    for (const k of kids) visit(k);
  };
  visit(node);
  return lines.size;
}

/** Deepest control-flow nesting inside `body`, not descending into nested functions. */
function maxDepth(body) {
  let max = 0;
  const visit = (n, depth) => {
    if (n !== body && ts.isFunctionLike(n)) return;
    const elseIf =
      ts.isIfStatement(n) && ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
    const d = NESTING.has(n.kind) && !elseIf ? depth + 1 : depth;
    max = Math.max(max, d);
    ts.forEachChild(n, (c) => visit(c, d));
  };
  visit(body, 0);
  return max;
}

function nameOf(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const p = node.parent;
  if (
    p &&
    (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
  ) {
    if (ts.isIdentifier(p.name)) return p.name.text;
  }
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression;
    if (ts.isPropertyAccessExpression(callee)) return `<${callee.name.text} callback>`;
    if (ts.isIdentifier(callee)) return `<${callee.text} callback>`;
  }
  return '<anonymous>';
}

function measureFile(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({
        file: relative(root, file),
        line,
        name: nameOf(node),
        lines: codeLines(node.body, sf),
        params: node.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
          .length,
        depth: maxDepth(node.body),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const violationsOf = (f) =>
  [
    f.lines > LIMITS.lines && `${f.lines} lines`,
    f.params > LIMITS.params && `${f.params} params`,
    f.depth > LIMITS.depth && `depth ${f.depth}`,
  ].filter(Boolean);

const functions = walk(join(root, 'src')).flatMap(measureFile);
const offenders = functions.filter((f) => violationsOf(f).length > 0);
const counts = {};
for (const f of offenders) counts[f.file] = (counts[f.file] ?? 0) + violationsOf(f).length;
const current = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const describe = (f) => `${f.file}:${f.line} ${f.name} (${violationsOf(f).join(', ')})`;

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).files;
} catch {
  baseline = undefined;
}
const worse = baseline
  ? Object.keys(current).filter((file) => current[file] > (baseline[file] ?? 0))
  : [];
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);

if (args.includes('--list')) for (const f of offenders) console.log(describe(f));
if (top > 0) {
  const ranked = [...offenders]
    .sort((a, b) => b.lines - a.lines || b.params - a.params)
    .slice(0, top);
  for (const f of ranked) console.log(describe(f));
}

if (args.includes('--update')) {
  if (worse.length) {
    console.error(`refusing to raise the shape baseline for: ${worse.join(', ')}`);
    process.exit(1);
  }
  const note = `Function-shape baseline (scripts/check-shape.mjs): violations per file of body > ${LIMITS.lines} lines, > ${LIMITS.params} params, nesting > ${LIMITS.depth}. May only go down; lower it with \`node scripts/check-shape.mjs --update\`.`;
  writeFileSync(baselinePath, `${JSON.stringify({ note, files: current }, null, 2)}\n`);
  console.log(
    `shape baseline written: ${total(current)} violations in ${Object.keys(current).length} files`,
  );
  process.exit(0);
}

if (!baseline) {
  console.error(
    'no scripts/shape-baseline.json; create it with `node scripts/check-shape.mjs --update`',
  );
  process.exit(1);
}
if (worse.length) {
  console.error('function-shape check: more violations than the baseline allows:');
  for (const file of worse) {
    console.error(`  ${file}: ${current[file]} (baseline ${baseline[file] ?? 0})`);
    for (const f of offenders.filter((o) => o.file === file)) console.error(`    ${describe(f)}`);
  }
  console.error('split the function (plan vs I/O, smaller helpers) or pass an options object.');
  process.exit(1);
}
console.log(
  `function-shape ok: ${total(current)} violations in ${offenders.length} functions (baseline ${total(baseline)})`,
);
