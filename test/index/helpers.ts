/**
 * Scanning in index tests: `scanSource` with the fake secret scanner. src/index/scan.ts wires the
 * real `src/secrets/scan.ts`, which does not exist on this branch until integration.
 */
import type { ScanResult, Source } from '../../src/core/types.js';
import { scanSourceWith } from '../../src/index/scanner.js';
import { fakeSecrets } from './contract-fakes.js';

export function scanSource(root: string, source: Source): Promise<ScanResult> {
  return scanSourceWith(root, source, fakeSecrets);
}
