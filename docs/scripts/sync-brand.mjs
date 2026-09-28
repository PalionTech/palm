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
//   public/favicon.svg                   favicon (follows dark mode)
//   public/favicon.ico, favicon-*.png    favicon fallbacks for browsers without SVG favicons
//   public/apple-touch-icon.png          iOS home screen icon
//   public/icon-192.png, icon-512.png    web manifest icons
//   public/site.webmanifest              web manifest, when both manifest icons exist
//   public/social-card.png               Open Graph image, when brand/social-card.png exists
//
// Each output takes the first source that exists, so the site builds while the brand work is in
// progress: final files in brand/ first, then the recommended candidate (concept A). The PNG and
// ICO files have no fallback; a missing one is reported and left out of the page head.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(DOCS, '..', 'brand');
const ASSETS = join(DOCS, 'src', 'assets', 'brand');
const PUBLIC = join(DOCS, 'public');
const BASE = '/palm';

const FROND = '#12876A';
const MINT = '#3DD6A3';
const PAPER = '#FFFFFF';
const FALLBACK_MARK = 'candidates/palm-logo-a.svg';

/** Raster icons copied as they are from brand/ into public/. */
const ICONS = [
  'favicon.ico',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
];

/** Everything this script writes into public/, removed before each run. */
const PUBLIC_OUTPUTS = ['favicon.svg', ...ICONS, 'site.webmanifest', 'social-card.png'];

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

/** Copy the raster favicon set; returns the names that were copied. */
function syncIcons(used) {
  const copied = [];
  for (const name of ICONS) {
    const src = firstExisting([name]);
    if (!src) {
      process.stderr.write(`sync-brand: brand/${name} not found; the page head leaves it out\n`);
      continue;
    }
    copyFileSync(src, join(PUBLIC, name));
    used.push(src);
    copied.push(name);
  }
  return copied;
}

/** Write site.webmanifest when both manifest icons were copied; returns whether it was. */
function writeManifest(icons) {
  if (!icons.includes('icon-192.png') || !icons.includes('icon-512.png')) return false;
  const icon = (size, purpose) => ({
    src: `${BASE}/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  });
  const manifest = {
    name: 'palm',
    short_name: 'palm',
    start_url: `${BASE}/`,
    display: 'browser',
    background_color: PAPER,
    theme_color: FROND,
    icons: [icon(192, 'any'), icon(512, 'any'), icon(512, 'maskable')],
  };
  writeFileSync(join(PUBLIC, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

function main() {
  rmSync(ASSETS, { recursive: true, force: true });
  // public/brand/ held these files before they moved to the site root.
  rmSync(join(PUBLIC, 'brand'), { recursive: true, force: true });
  for (const name of PUBLIC_OUTPUTS) rmSync(join(PUBLIC, name), { force: true });
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(PUBLIC, { recursive: true });

  const used = [];
  syncMarks(used);
  const wordmark = syncWordmark(used);
  const socialCard = syncSocialCard(used);
  const icons = syncIcons(used);
  const manifest = writeManifest(icons);
  writeFileSync(
    join(ASSETS, 'brand.json'),
    `${JSON.stringify({ wordmark, socialCard, icons, manifest }, null, 2)}\n`,
  );

  const fallback = used.some((f) => f.endsWith(FALLBACK_MARK));
  const names = [...new Set(used.map((f) => relative(BRAND, f)))].join(', ');
  process.stdout.write(`sync-brand: ${names}${fallback ? ' (fallback mark in use)' : ''}\n`);
}

main();
