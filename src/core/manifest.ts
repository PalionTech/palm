/** facade: prefer src/domain (DepRef in domain/dep-ref.ts, Manifest in domain/manifest.ts). */
import { DepRef } from '../domain/dep-ref.js';
import { Manifest as ManifestDoc } from '../domain/manifest.js';
import type { DepRef as DepRefData, DepSpec, Kind, Manifest, McpManifestEntry } from './types.js';

export { isMcpManifestEntry, loadYaml } from '../domain/manifest.js';
/** @deprecated wave1: import from lib */
export { deepEqual } from '../lib/object.js';

/** Parse `<name>[@<origin>][#<ref>]` (DESIGN.md §3). See `DepRef.parse`. */
export function parseDepRef(spec: string): DepRefData {
  return DepRef.parse(spec).toJSON();
}

export function formatDepRef(ref: DepRefData): string {
  return DepRef.from(ref).toString();
}

export function normalizeDep(spec: DepSpec): DepRefData {
  return DepRef.from(spec).toJSON();
}

/** Add or replace (same name, case-insensitive) a dependency in the kind's section. Returns a new manifest. */
export function addDep(m: Manifest, kind: Kind, dep: DepRefData | McpManifestEntry): Manifest {
  return ManifestDoc.of(m).addDep(kind, dep).toJSON();
}

export function removeDep(m: Manifest, kind: Kind, name: string): Manifest {
  const doc = ManifestDoc.of(m);
  return doc.hasDep(kind, name) ? doc.removeDep(kind, name).toJSON() : m;
}

export function listDeps(m: Manifest, kind: Kind): Array<DepRefData | McpManifestEntry> {
  return ManifestDoc.of(m)
    .deps(kind)
    .map((d) => (d instanceof DepRef ? d.toJSON() : d));
}

export async function loadManifest(file: string): Promise<Manifest> {
  return (await ManifestDoc.load(file)).toJSON();
}

export async function saveManifest(file: string, m: Manifest): Promise<void> {
  await ManifestDoc.of(m).save(file);
}
