/**
 * Scan orchestration (DESIGN §5): check the root, detect the rule, walk the source once, run the
 * rule and the passes that follow it, and assemble the ScanResult. References and closures are
 * resolved as hook sets and servers are added; the hidden-Unicode and secrets passes follow.
 *
 * Rule order: descriptor > apm > marketplace > plugin manifest > convention. Plugin rules are
 * followed by a convention pass over the rest of the tree, so skills on disk that a manifest does
 * not declare are still indexed (standalone, with a warning).
 */

import { stat } from 'node:fs/promises';
import { messageOf, PalmError } from '../core/errors.js';
import type { ScanResult, Source } from '../core/types.js';
import { type Detection, detectLayout, type ScanRule } from './detect.js';
import { checkHiddenUnicode } from './hidden-unicode.js';
import { issueWarnings } from './issues.js';
import { scanApm } from './rules/apm.js';
import { scanConvention } from './rules/convention.js';
import { scanDescriptor } from './rules/descriptor.js';
import { scanMarketplace } from './rules/marketplace.js';
import { scanNestedPlugins, scanPlugin } from './rules/plugin-manifest.js';
import { ScanContext } from './scan-context.js';
import { checkSecrets, type SecretScanner } from './secrets.js';

async function assertDirectory(ctx: ScanContext): Promise<void> {
  try {
    if (!(await stat(ctx.rootAbs)).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    const cause = messageOf(e);
    throw new PalmError(
      'E_IO',
      `cannot scan source "${ctx.sourceName}": ${ctx.rootAbs} is not a readable directory (${cause})`,
      ctx.source.type === 'git' ? 'palm cache clean' : undefined,
    );
  }
}

async function runMarketplace(
  ctx: ScanContext,
  detection: Detection,
): Promise<ScanRule | undefined> {
  if (await scanMarketplace(ctx, detection.marketplaceFile as string, detection.rootManifest)) {
    await scanConvention(ctx);
    return 'marketplace';
  }
  // An unusable marketplace file: the next rule that applies.
  return runRule(ctx, {
    rule: detection.rootManifest ? 'plugin-manifest' : 'convention',
    rootManifest: detection.rootManifest,
  });
}

/** Apply one detection rule. Returns the rule to report, or undefined when it found nothing to apply. */
async function runRule(ctx: ScanContext, detection: Detection): Promise<ScanRule | undefined> {
  switch (detection.rule) {
    case 'descriptor':
      await scanDescriptor(ctx, ctx.layout ?? {});
      return 'descriptor';
    case 'apm':
      return (await scanApm(ctx, detection.apmFile ?? 'apm.yml')) ? 'apm' : undefined;
    case 'marketplace':
      return runMarketplace(ctx, detection);
    case 'plugin-manifest':
      await scanPlugin(ctx, { rootRel: '', manifest: detection.rootManifest });
      await scanConvention(ctx);
      return 'plugin-manifest';
    case 'convention': {
      const nested = await scanNestedPlugins(ctx);
      await scanConvention(ctx);
      return nested > 0 ? 'plugin-manifest' : 'convention';
    }
  }
}

/** The detected rule, falling back past an apm.yml without primitives. */
async function runDetected(ctx: ScanContext, detection: Detection): Promise<ScanRule> {
  const rule = await runRule(ctx, detection);
  if (rule !== undefined) return rule;
  const next = await detectLayout(ctx.rootAbs, ctx.layout, [], { skipApm: true });
  return (await runRule(ctx, next)) ?? 'convention';
}

/**
 * Index the source checked out at `root` (DESIGN §5) with the given secret scanner; scan.ts
 * passes `src/secrets/scan.ts`.
 */
export async function scanSourceWith(
  root: string,
  source: Source,
  secrets: SecretScanner,
): Promise<ScanResult> {
  const ctx = new ScanContext(root, source);
  await assertDirectory(ctx);
  const detection = await detectLayout(ctx.rootAbs, ctx.layout, ctx.warnings);
  await ctx.buildIndex(detection.rule === 'descriptor');
  const rule = await runDetected(ctx, detection);
  ctx.registry.applyInclude(ctx.layout?.include);
  ctx.registry.warnUndeclared();
  await checkHiddenUnicode(ctx);
  await checkSecrets(ctx, secrets);
  const entities = ctx.registry.entities;
  ctx.warnings.push(...issueWarnings(entities));
  return {
    entities,
    warnings: ctx.warnings,
    detected: entities.length === 0 ? 'empty' : rule,
  };
}
