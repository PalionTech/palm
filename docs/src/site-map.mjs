// The docs site map: one source of truth for the sidebar order (R6 site map, PLAN.md section 5).
//
// Every slug here must have a page in src/content/docs. Pages marked `draft: true` show in
// `astro dev` and are left out of `astro build`, together with any group that ends up empty.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_COMMANDS = [
  'install',
  'uninstall',
  'get',
  'describe',
  'update',
  'search',
  'create',
  'init',
  'doctor',
  'config',
  'completion',
  'cache',
  'audit',
  'why',
  'find',
  'outdated',
];

export const siteMap = [
  {
    label: 'Getting started',
    items: ['getting-started', 'getting-started/install', 'getting-started/quick-start'],
  },
  {
    label: 'Concepts',
    items: [
      'concepts/entities',
      'concepts/origins',
      'concepts/targets',
      'concepts/scopes',
      'concepts/manifest-and-lockfile',
      'concepts/dependencies',
      'concepts/scanning',
      'concepts/mcp-and-secrets',
    ],
  },
  {
    label: 'Guides',
    items: [
      'guides/new-project',
      'guides/six-harnesses',
      'guides/team-baseline',
      'guides/publish-your-own',
      'guides/mcp-secrets',
      'guides/migrate-from-apm',
      'guides/adopt-existing-files',
      'guides/agent-bundles',
      'guides/plugins-and-marketplaces',
      'guides/ci',
      'guides/palm-friendly-repos',
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
      'reference/config-yaml',
      'reference/layout',
      'reference/targets-matrix',
      'reference/scan-rules',
      'reference/exit-codes',
      'reference/environment',
      'reference/troubleshooting',
      'reference/policies',
      'reference/glossary',
    ],
  },
  {
    label: 'Explanation',
    items: [
      'explanation/why-origins',
      'explanation/why-native-files',
      'explanation/security',
      'explanation/comparison',
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
