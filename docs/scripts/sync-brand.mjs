#!/usr/bin/env node
// Copies the brand assets from ../brand into the docs site before every dev and build run.
//
//   node scripts/sync-brand.mjs
//
// Outputs (gitignored, regenerated on every run):
//   src/assets/brand/mark-light.svg      hero image on light backgrounds (frond green)
//   src/assets/brand/mark-dark.svg       hero image on dark backgrounds (mint)
//   src/assets/brand/wordmark-*.svg      header logo, when brand/wordmark.svg exists
//   src/assets/brand/brand.json          what was found, read by astro.config.mjs
//   public/brand/favicon.svg             favicon
//   public/brand/social-card.png         Open Graph image, when brand/social-card.png exists
//
// Each output takes the first source that exists, so the site builds while the brand work is in
// progress: final files in brand/ first, then the recommended candidate (concept A).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(DOCS, '..', 'brand');
const ASSETS = join(DOCS, 'src', 'assets', 'brand');
const PUBLIC = join(DOCS, 'public', 'brand');

const FROND = '#12876A';
const MINT = '#3DD6A3';
const FALLBACK_MARK = 'candidates/palm-logo-a.svg';

function firstExisting(names) {
  for (const name of names) {
    const file = join(BRAND, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Give a single-colour SVG a fixed fill: drop embedded <style> blocks, replace currentColor. */
function recolor(svg, color) {
  return svg.replace(/<style[\s\S]*?<\/style>\s*/g, '').replaceAll('currentColor', color);
}

/** Write the first existing source to `out`, recoloured when it uses currentColor. */
function writeSvg(sourceNames, color, out) {
  const src = firstExisting(sourceNames);
  if (!src) return undefined;
  const svg = readFileSync(src, 'utf8');
  writeFileSync(out, svg.includes('currentColor') ? recolor(svg, color) : svg);
  return src;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function syncMarks(used) {
  const light = ['mark-light.svg', 'mark-green.svg', 'mark.svg', FALLBACK_MARK];
  const dark = ['mark-dark.svg', 'mark.svg', FALLBACK_MARK];
  const favicon = ['favicon.svg', 'mark.svg', FALLBACK_MARK];
  const outputs = [
    [light, FROND, join(ASSETS, 'mark-light.svg')],
    [dark, MINT, join(ASSETS, 'mark-dark.svg')],
    [favicon, FROND, join(PUBLIC, 'favicon.svg')],
  ];
  for (const [names, color, out] of outputs) {
    const src = writeSvg(names, color, out);
    if (!src) throw new Error(`no brand mark in ${BRAND} (looked for ${names.join(', ')})`);
    used.push(src);
  }
}

function syncWordmark(used) {
  const light = writeSvg(['wordmark.svg'], FROND, join(ASSETS, 'wordmark-light.svg'));
  const dark = writeSvg(['wordmark-dark.svg'], MINT, join(ASSETS, 'wordmark-dark.svg'));
  if (light && dark) {
    used.push(light, dark);
    return true;
  }
  rmSync(join(ASSETS, 'wordmark-light.svg'), { force: true });
  rmSync(join(ASSETS, 'wordmark-dark.svg'), { force: true });
  return false;
}

function syncSocialCard(used) {
  const card = firstExisting(['social-card.png']);
  if (!card) {
    process.stderr.write(
      'sync-brand: brand/social-card.png not found; pages build without og:image\n',
    );
    return null;
  }
  copyFileSync(card, join(PUBLIC, 'social-card.png'));
  used.push(card);
  return pngSize(card);
}

function main() {
  rmSync(ASSETS, { recursive: true, force: true });
  rmSync(PUBLIC, { recursive: true, force: true });
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(PUBLIC, { recursive: true });

  const used = [];
  syncMarks(used);
  const wordmark = syncWordmark(used);
  const socialCard = syncSocialCard(used);
  writeFileSync(
    join(ASSETS, 'brand.json'),
    `${JSON.stringify({ wordmark, socialCard }, null, 2)}\n`,
  );

  const fallback = used.some((f) => f.endsWith(FALLBACK_MARK));
  const names = [...new Set(used.map((f) => relative(BRAND, f)))].join(', ');
  process.stdout.write(`sync-brand: ${names}${fallback ? ' (fallback mark in use)' : ''}\n`);
}

main();
