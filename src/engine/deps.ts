/**
 * The engine's collaborators (types.ts `EngineDeps`): the scanner, the targets, exec units and
 * consent, and the secrets policy. Defaults are imported only when the caller does not supply
 * one, so a test that passes fakes never loads the real module, and `palm --help` loads none.
 */
import { messageOf, PalmError } from '../core/errors.js';
import type { EngineDeps } from '../core/types.js';

export type { EngineDeps } from '../core/types.js';

function unavailable(file: string, e: unknown): PalmError {
  return new PalmError('E_INTERNAL', `palm module unavailable (${file}): ${messageOf(e)}`);
}

async function load<T>(file: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (e) {
    throw unavailable(file, e);
  }
}

const scanModule = () => load('src/index/scan.ts', () => import('../index/scan.js'));
const targetsModule = () => load('src/targets/index.ts', () => import('../targets/index.js'));
const unitsModule = () => load('src/exec/units.ts', () => import('../exec/units.js'));
const consentModule = () => load('src/exec/consent.ts', () => import('../exec/consent.js'));
const scanSecretsModule = () => load('src/secrets/scan.ts', () => import('../secrets/scan.js'));
const policyModule = () => load('src/secrets/policy.ts', () => import('../secrets/policy.js'));
const resolveModule = () => load('src/secrets/resolve.ts', () => import('../secrets/resolve.js'));

/** Asynchronous defaults: imported on their first call. */
const lazy: Pick<EngineDeps, 'scan' | 'askConsent' | 'decideSecret' | 'resolveSecrets'> = {
  scan: async (root, source) => (await scanModule()).scanSource(root, source),
  askConsent: async (ctx, req) => (await consentModule()).askConsent(ctx, req),
  decideSecret: async (input) => (await policyModule()).decideSecret(input),
  resolveSecrets: async (ctx, cfg, policy) =>
    (await resolveModule()).resolveSecrets(ctx, cfg, policy),
};

/** Synchronous defaults (`getTarget`, `execUnit`, `scanSecrets`): imported here, only when missing. */
async function syncDefaults(
  partial: Partial<EngineDeps>,
): Promise<Pick<EngineDeps, 'getTarget' | 'execUnit' | 'scanSecrets'>> {
  return {
    getTarget: partial.getTarget ?? (await targetsModule()).getTarget,
    execUnit: partial.execUnit ?? (await unitsModule()).execUnitOf,
    scanSecrets: partial.scanSecrets ?? (await scanSecretsModule()).scanSecrets,
  };
}

/** The caller's collaborators over lazily imported defaults. */
export async function resolveEngineDeps(partial: Partial<EngineDeps> = {}): Promise<EngineDeps> {
  return {
    scan: partial.scan ?? lazy.scan,
    askConsent: partial.askConsent ?? lazy.askConsent,
    decideSecret: partial.decideSecret ?? lazy.decideSecret,
    resolveSecrets: partial.resolveSecrets ?? lazy.resolveSecrets,
    ...(await syncDefaults(partial)),
  };
}
