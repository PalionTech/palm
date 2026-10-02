/**
 * The scanner's public entry point: `scanSource(root, source)` turns a checked-out source
 * directory into an index of entities (DESIGN §5). Everything else in src/index is internal to it
 * or a parser; the orchestration lives in scanner.ts, one module per rule in rules/.
 */

import type { ScanResult, Source } from '../core/types.js';
import { detectSecrets, redact, scanSecrets, scanText, urlSecret } from '../secrets/scan.js';
import { scanSourceWith } from './scanner.js';

export function scanSource(root: string, source: Source): Promise<ScanResult> {
  return scanSourceWith(root, source, { scanSecrets, scanText, redact, detectSecrets, urlSecret });
}
