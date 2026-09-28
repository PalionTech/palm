// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import { buildSidebar } from './src/site-map.mjs';

const SITE = 'https://paliontech.github.io';
const BASE = '/palm';
const REPO = 'https://github.com/PalionTech/palm';
const DESCRIPTION =
  "palm installs skills, subagents, instructions, hooks, MCP servers and plugins from git repositories. It writes them into Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI and OpenCode, in each tool's native format. A lockfile records every file it writes, so installs repeat and removals are exact.";

// Draft pages exist in `astro dev` only; the production sidebar must not point at them.
const isBuild = process.argv.slice(2).includes('build');
const docsDir = fileURLToPath(new URL('./src/content/docs', import.meta.url));

// Written by scripts/sync-brand.mjs, which runs before `dev` and `build`.
/**
 * @type {{
 *   wordmark: boolean,
 *   socialCard: { width: number, height: number } | null,
 *   icons?: string[],
 *   manifest?: boolean,
 * }}
 */
const brand = readBrand();

function readBrand() {
  const file = new URL('./src/assets/brand/brand.json', import.meta.url);
  if (!existsSync(file)) throw new Error('brand assets missing: run `npm run sync:brand` in docs/');
  return JSON.parse(readFileSync(file, 'utf8'));
}

const logo = brand.wordmark
  ? {
      light: './src/assets/brand/wordmark-light.svg',
      dark: './src/assets/brand/wordmark-dark.svg',
      alt: 'palm',
      replacesTitle: true,
    }
  : { light: './src/assets/brand/mark-light.svg', dark: './src/assets/brand/mark-dark.svg' };

/** @param {Record<string, string>} attrs */
const meta = (attrs) => ({ tag: /** @type {const} */ ('meta'), attrs });
/** @param {Record<string, string>} attrs */
const link = (attrs) => ({ tag: /** @type {const} */ ('link'), attrs });

/** Open Graph and Twitter image tags for the social card, served at the site root. */
function socialCardHead() {
  if (!brand.socialCard) return [];
  const url = `${SITE}${BASE}/social-card.png`;
  const alt = 'palm: one setup for every coding agent.';
  return [
    meta({ property: 'og:image', content: url }),
    meta({ property: 'og:image:type', content: 'image/png' }),
    meta({ property: 'og:image:width', content: String(brand.socialCard.width) }),
    meta({ property: 'og:image:height', content: String(brand.socialCard.height) }),
    meta({ property: 'og:image:alt', content: alt }),
    meta({ name: 'twitter:image', content: url }),
    meta({ name: 'twitter:image:alt', content: alt }),
  ];
}

/**
 * Favicon fallbacks next to Starlight's SVG favicon: the ICO and PNG sizes for browsers without
 * SVG favicons (Safari tabs), the iOS home screen icon and the web manifest. Starlight prefixes
 * only its own favicon with the base, so these hrefs carry it.
 */
function iconHead() {
  const icons = new Set(brand.icons ?? []);
  /** @type {ReturnType<typeof link>[]} */
  const tags = [];
  if (icons.has('favicon.ico'))
    tags.push(link({ rel: 'icon', href: `${BASE}/favicon.ico`, sizes: '32x32' }));
  for (const size of [16, 32, 48]) {
    const name = `favicon-${size}.png`;
    if (icons.has(name))
      tags.push(
        link({ rel: 'icon', type: 'image/png', sizes: `${size}x${size}`, href: `${BASE}/${name}` }),
      );
  }
  if (icons.has('apple-touch-icon.png'))
    tags.push(
      link({ rel: 'apple-touch-icon', sizes: '180x180', href: `${BASE}/apple-touch-icon.png` }),
    );
  if (brand.manifest) tags.push(link({ rel: 'manifest', href: `${BASE}/site.webmanifest` }));
  return tags;
}

/**
 * Astro's generated content-asset modules start with "use astro:head-inject", which Rolldown
 * reports as MODULE_LEVEL_DIRECTIVE for every MDX page. Drop exactly that message.
 * @type {import('rolldown').InputOptions['onLog']}
 */
function onLog(level, log, handler) {
  if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('astro:head-inject')) return;
  handler(level, log);
}

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  vite: { build: { rolldownOptions: { onLog } } },
  integrations: [
    starlight({
      title: 'palm',
      description: DESCRIPTION,
      logo,
      favicon: '/favicon.svg',
      customCss: ['@fontsource-variable/jetbrains-mono/wght.css', './src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      lastUpdated: true,
      head: [...iconHead(), ...socialCardHead()],
      components: { Hero: './src/components/Hero.astro' },
      disable404Route: true,
      sidebar: buildSidebar(docsDir, { includeDrafts: !isBuild }),
      plugins: [
        starlightLinksValidator(),
        starlightLlmsTxt({
          projectName: 'palm',
          description: DESCRIPTION,
          details:
            'palm is a command-line package manager (`npm install -g @paliontech/palm`, binary `palm`). An origin is a git repository or local folder; an entity is one installable item; a target is a harness identifier (`claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode`).',
          // Heading anchor links would print as "Section titled ..." lines.
          customSelectors: { all: ['.sl-anchor-link'] },
        }),
      ],
    }),
  ],
});
