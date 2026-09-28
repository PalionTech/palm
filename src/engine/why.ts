/**
 * `palm why <kind> <name>`: why an entity is installed. Reads the scope's lock and manifest
 * only: the entry is either listed in palm.yaml (direct) or was pulled in by a plugin or an
 * agent (`via`), whose own chain leads up to a root; other plugins and agents that declare it
 * keep it installed when that root goes (`Lock.usersOf`).
 */
import { manifestKey } from '../core/kinds.js';
import type { Kind, LockEntry, PalmContext, Scope } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { notInstalled } from './query.js';

/** An installed entry, as `palm why` names it. */
export interface WhyNode {
  kind: Kind;
  name: string;
  origin: string;
}

export interface WhyReport {
  scope: Scope;
  entry: WhyNode;
  /** palm.yaml lists the entity itself (section `palm.yaml <section>`). */
  direct: boolean;
  /** The manifest section that lists the root of the chain, when one does. */
  listedIn?: string;
  /** The entry, the plugin/agent that pulled it in, and so on up to the root (the entry itself when direct). */
  chain: WhyNode[];
  /** Plugins and agents still installed that declare this entity (they keep it on uninstall). */
  neededBy: WhyNode[];
}

const node = (e: LockEntry): WhyNode => ({ kind: e.kind, name: e.name, origin: e.origin });

/** The entry and its `via` parents, bottom up; a cycle stops at the first repeat. */
function viaChain(lock: Lock, entry: LockEntry): LockEntry[] {
  const chain = [entry];
  const seen = new Set([lockId(entry)]);
  for (let p = lock.parentOf(entry); p && !seen.has(lockId(p)); p = lock.parentOf(p)) {
    seen.add(lockId(p));
    chain.push(p);
  }
  return chain;
}

/** Why `entry` is installed: pure over the loaded lock and manifest. */
function explainEntry(lock: Lock, manifest: Manifest, entry: LockEntry, scope: Scope): WhyReport {
  const chain = viaChain(lock, entry);
  const direct = manifest.lists(entry);
  const listed = direct ? entry : chain.find((e) => manifest.lists(e));
  const report: WhyReport = {
    scope,
    entry: node(entry),
    direct,
    chain: chain.map(node),
    neededBy: lock.usersOf(entry).map(node),
  };
  if (listed) report.listedIn = manifestKey(listed.kind);
  return report;
}

/**
 * Why each installed entry the query names is installed (one report per origin it came from).
 * E_NOT_FOUND when nothing matches.
 */
export async function whyInstalled(
  ctx: PalmContext,
  query: { kind: Kind; name: string; origin?: string | undefined },
  opts: { scope: Scope },
): Promise<WhyReport[]> {
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const matches = lock.select(query);
  if (!matches.length) throw notInstalled(query, opts.scope);
  const manifest = await Manifest.load(paths.manifestFile);
  return matches.map((e) => explainEntry(lock, manifest, e, opts.scope));
}
