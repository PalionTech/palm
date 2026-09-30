// The docs site map: one source of truth for the sidebar order.
//
// Every slug here must have a page in src/content/docs. Pages marked `draft: true` show in
// `astro dev` and are left out of `astro build`, together with any group that ends up empty.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Verbs first, in the order of `palm --help`, then the utilities.
const CLI_COMMANDS = [
  'init',
  'install',
  'remove',
  'update',
  'check',
  'get',
  'describe',
  'create',
  'migrate',
  'completion',
  'cache',
];

export const siteMap = [
  {
    label: 'Getting started',
    items: ['getting-started', 'getting-started/install', 'getting-started/quick-start'],
  },
  {
    label: 'Concepts',
    items: [
      'concepts/sources',
      'concepts/entities',
      'concepts/targets',
      'concepts/scopes',
      'concepts/manifest-and-lockfile',
      'concepts/consent',
      'concepts/secrets',
      'concepts/scanning',
    ],
  },
  {
    label: 'Guides',
    items: [
      'guides/new-project',
      'guides/team-baseline',
      'guides/ci',
      'guides/migrate-from-0-1',
      'guides/migrate-from-apm',
      'guides/mcp-servers',
      'guides/adopt-existing-files',
      'guides/plugins-and-marketplaces',
      'guides/publish-your-own',
      'guides/six-harnesses',
      'guides/monorepos',
    ],
  },
  {
    label: 'Reference',
    items: [
      'reference/cli',
      {
        label: 'Commands',
        collapsed: true,
        items: CLI_COMMANDS.map((c) => `reference/cli/${c}`),
      },
      'reference/palm-yaml',
      'reference/palm-lock-yaml',
      'reference/exit-codes',
      'reference/environment',
      'reference/layout',
      'reference/scan-rules',
      'reference/targets-matrix',
      'reference/policies',
      'reference/glossary',
      'reference/troubleshooting',
    ],
  },
  {
    label: 'Explanation',
    items: [
      'explanation/why-native-files',
      'explanation/why-sources',
      'explanation/comparison',
      'explanation/security',
    ],
  },
];

function pageFile(docsDir, slug) {
  const candidates = ['.md', '.mdx', '/index.md', '/index.mdx'].map((ext) =>
    join(docsDir, `${slug}${ext}`),
  );
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`site map: no page for slug "${slug}" in ${docsDir}`);
  return file;
}

function isDraft(file) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
  return frontmatter !== null && /^draft:\s*true\s*$/m.test(frontmatter[1]);
}

function resolveItems(items, docsDir, includeDrafts) {
  const out = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (includeDrafts || !isDraft(pageFile(docsDir, item))) out.push(item);
      continue;
    }
    const nested = resolveItems(item.items, docsDir, includeDrafts);
    if (nested.length > 0) out.push({ ...item, items: nested });
  }
  return out;
}

/** Starlight `sidebar` config from the site map; drafts are dropped unless `includeDrafts`. */
export function buildSidebar(docsDir, { includeDrafts }) {
  return resolveItems(siteMap, docsDir, includeDrafts);
}

/** Every slug in the site map, in order. */
export function allSlugs(items = siteMap) {
  return items.flatMap((item) => (typeof item === 'string' ? [item] : allSlugs(item.items)));
}
