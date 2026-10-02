/**
 * Scan issues (DESIGN §5 "Scan issues"): each finding is one `Entity.issues` entry, and each
 * affected entity adds one line per issue code to `ScanResult.warnings`, naming its worst finding.
 */

import type { Entity, EntityIssue } from '../core/types.js';
import { plural } from '../lib/text.js';

type IssueCode = EntityIssue['code'];

/** Warning line order per entity, and the noun its "N more" counts. */
const CODES: ReadonlyArray<[IssueCode, string]> = [
  ['unresolvable-reference', 'reference'],
  ['hidden-unicode', 'file'],
  ['secret-literal', 'value'],
  ['oversized', 'file'],
];

/** Append issues to an entity; an entity without findings keeps no `issues` key. */
export function addIssues(e: Entity, issues: readonly EntityIssue[]): void {
  if (issues.length > 0) e.issues = [...(e.issues ?? []), ...issues];
}

function warningFor(e: Entity, code: IssueCode, noun: string, issues: EntityIssue[]): string {
  const worst = issues.find((i) => i.severity === 'critical') ?? (issues[0] as EntityIssue);
  const more = issues.length > 1 ? `; ${plural(issues.length - 1, `more ${noun}`)}` : '';
  return `${code}: ${e.kind} "${e.name}" (${worst.severity}): ${worst.message}${more}`;
}

/** One warning line per (entity, issue code), in entity order. */
export function issueWarnings(entities: readonly Entity[]): string[] {
  const lines: string[] = [];
  for (const e of entities) {
    for (const [code, noun] of CODES) {
      const issues = (e.issues ?? []).filter((i) => i.code === code);
      if (issues.length > 0) lines.push(warningFor(e, code, noun, issues));
    }
  }
  return lines;
}
