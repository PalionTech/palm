import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { originId } from './config.js';
import { PalmError } from './errors.js';
import { cacheDir } from './paths.js';
import type { OriginCheckout, OriginSpec, PalmContext } from './types.js';

/** Never let git block on a credential prompt: private repos fail fast. */
const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

const NETWORK_PATTERNS = [/could not resolve host/i, /unable to access/i, /network is unreachable/i, /connection (timed out|refused)/i];

class GitFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const r = await execa('git', args, { cwd, env: GIT_ENV, stdin: 'ignore' });
    return r.stdout;
  } catch (e) {
    const err = e as { code?: string; stderr?: unknown; shortMessage?: string; message: string };
    if (err.code === 'ENOENT') throw new PalmError('E_GIT', 'git is not installed or not on PATH', 'Install git and retry.');
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const detail =
      stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('hint:'))
        .slice(-3)
        .join(' | ') ||
      err.shortMessage ||
      err.message;
    throw new GitFailure(`git ${args.find((a) => !a.startsWith('-')) ?? args[0]} failed: ${detail}`, detail);
  }
}

function toPalmError(e: unknown, what: string, url: string): PalmError {
  if (e instanceof PalmError) return e;
  const detail = e instanceof GitFailure ? e.detail : (e as Error).message;
  if (NETWORK_PATTERNS.some((p) => p.test(detail))) {
    return new PalmError('E_NETWORK', `${what} ${url}: ${detail}`, 'Check your network connection, or use --offline to work from the cache.');
  }
  return new PalmError(
    'E_GIT',
    `${what} ${url}: ${detail}`,
    'Check the URL and ref. Private repositories need credentials configured for git (ssh key or credential helper).',
  );
}

// ---------------------------------------------------------------------------
// Tags and refs
// ---------------------------------------------------------------------------

/** Refuse values git would parse as options, and roots that escape the checkout. */
function assertSafeSpec(spec: { alias?: string; url?: string; ref?: string; root?: string }): void {
  const bad = (what: string, v: string): PalmError =>
    new PalmError('E_ORIGIN', `Invalid ${what} "${v}"${spec.alias ? ` for origin "${spec.alias}"` : ''}`);
  if (spec.url?.startsWith('-')) throw bad('url', spec.url);
  if (spec.ref?.startsWith('-')) throw bad('ref', spec.ref);
  if (spec.root && (spec.root.split(/[\\/]+/).includes('..') || spec.root.startsWith('/'))) throw bad('root', spec.root);
}

export async function listRemoteTags(url: string): Promise<string[]> {
  assertSafeSpec({ url });
  let out: string;
  try {
    out = await git(['ls-remote', '--tags', '--refs', url]);
  } catch (e) {
    throw toPalmError(e, 'Cannot list tags of', url);
  }
  const tags: string[] = [];
  for (const line of out.split('\n')) {
    const ref = line.split('\t')[1];
    if (ref?.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
  }
  return tags;
}

async function remoteDefaultBranch(url: string): Promise<string | undefined> {
  try {
    const out = await git(['ls-remote', '--symref', url, 'HEAD']);
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out);
    return m?.[1];
  } catch (e) {
    throw toPalmError(e, 'Cannot read default branch of', url);
  }
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(tag: string): SemVer | undefined {
  const m = SEMVER.exec(tag);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // release > prerelease
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

/** Highest semver tag (`v1.2.3` or `1.2.3`). Prereleases only count when there is no release. */
export function latestSemverTag(tags: string[]): string | undefined {
  const parsed = tags.map((t) => ({ t, v: parseSemver(t) })).filter((x): x is { t: string; v: SemVer } => !!x.v);
  const releases = parsed.filter((x) => x.v.pre.length === 0);
  const pool = releases.length ? releases : parsed;
  let best: { t: string; v: SemVer } | undefined;
  for (const x of pool) if (!best || compareSemver(x.v, best.v) > 0) best = x;
  return best?.t;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

interface CheckoutMeta {
  url: string;
  /** Ref actually checked out (tag, branch or sha); absent when the remote HEAD was cloned. */
  ref?: string;
  /** Ref that was requested by the origin spec; null = "latest". */
  requested: string | null;
  sha: string;
  fetchedAt: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_SHA = /^[0-9a-f]{7,39}$/i;

async function readMeta(file: string): Promise<CheckoutMeta | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CheckoutMeta;
  } catch {
    return undefined;
  }
}

async function fetchSha(dir: string, sha: string): Promise<void> {
  try {
    await git(['fetch', '--depth', '1', 'origin', sha], dir);
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', 'FETCH_HEAD'], dir);
  } catch {
    // Servers that refuse unadvertised shas: fall back to a full fetch.
    await git(['fetch', '--tags', 'origin'], dir);
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', sha], dir);
  }
}

async function freshClone(url: string, dir: string, ref: string | undefined): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  if (ref && FULL_SHA.test(ref)) {
    await git(['init', '-q', dir]);
    await git(['remote', 'add', 'origin', url], dir);
    await fetchSha(dir, ref);
    return;
  }
  const args = ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  try {
    await git([...args, url, dir]);
  } catch (e) {
    if (!ref || !SHORT_SHA.test(ref)) throw e;
    await rm(dir, { recursive: true, force: true });
    await git(['clone', '--quiet', url, dir]);
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', ref], dir);
  }
}

async function updateCheckout(url: string, dir: string, ref: string | undefined): Promise<void> {
  await git(['remote', 'set-url', 'origin', url], dir);
  if (ref && FULL_SHA.test(ref)) {
    await fetchSha(dir, ref);
  } else {
    await git(['fetch', '--quiet', '--depth', '1', 'origin', ref ?? 'HEAD'], dir);
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', 'FETCH_HEAD'], dir);
  }
  await git(['clean', '-ffdxq'], dir);
}

/** The ref to check out when the spec pins none: latest semver tag, else the default branch. */
async function resolveLatestRef(url: string): Promise<string | undefined> {
  const tag = latestSemverTag(await listRemoteTags(url));
  return tag ?? (await remoteDefaultBranch(url));
}

function checkoutResult(spec: OriginSpec, id: string, repoDir: string, meta: CheckoutMeta): OriginCheckout {
  const out: OriginCheckout = {
    spec,
    originId: id,
    root: spec.root ? join(repoDir, spec.root) : repoDir,
    repoDir,
    sha: meta.sha,
    fetchedAt: meta.fetchedAt,
  };
  if (meta.ref) out.ref = meta.ref;
  return out;
}

/**
 * Make an origin available on disk. Local origins are used in place; git
 * origins are cloned into `<palmHome>/cache/<originId>/repo` at the wanted ref.
 */
export async function fetchOrigin(ctx: PalmContext, spec: OriginSpec, opts: { refresh?: boolean } = {}): Promise<OriginCheckout> {
  assertSafeSpec(spec);
  const id = originId(spec);
  if (spec.type === 'local') {
    if (!spec.path) throw new PalmError('E_ORIGIN', `Local origin "${spec.alias}" has no path`);
    const root = spec.root ? join(spec.path, spec.root) : spec.path;
    if (!existsSync(root)) {
      throw new PalmError('E_ORIGIN', `Local origin "${spec.alias}" not found at ${root}`, `Fix or remove it: palm origin remove ${spec.alias}`);
    }
    return { spec, originId: id, root, repoDir: spec.path, fetchedAt: new Date().toISOString() };
  }

  const url = spec.url;
  if (!url) throw new PalmError('E_ORIGIN', `Git origin "${spec.alias}" has no url`);
  // One checkout slot per requested ref, so pinning `x@origin#v1` never moves the
  // checkout that other entities of the same origin are being read from.
  const dir = join(cacheDir(ctx.paths), id);
  const slot = spec.ref ? `ref-${spec.ref.replace(/[^A-Za-z0-9._-]/g, '-')}` : '';
  const repoDir = join(dir, slot ? slot : 'repo');
  const metaFile = join(dir, slot ? `checkout-${slot}.json` : 'checkout.json');
  const meta = existsSync(join(repoDir, '.git')) ? await readMeta(metaFile) : undefined;
  const have = !!meta && meta.url === url;
  const requested = spec.ref ?? null;

  let result: OriginCheckout | undefined;
  if (have && !opts.refresh && meta.requested === requested) {
    result = checkoutResult(spec, id, repoDir, meta);
  } else if (ctx.flags.offline) {
    const usable =
      have && (!spec.ref || meta.ref === spec.ref || meta.requested === spec.ref || meta.sha.startsWith(spec.ref.toLowerCase()));
    if (!usable) {
      throw new PalmError(
        'E_NETWORK',
        `Origin "${spec.alias}"${spec.ref ? ` at ${spec.ref}` : ''} is not in the cache and --offline is set`,
        'Run the command once without --offline to fetch it.',
      );
    }
    ctx.log.debug(`offline: using cached checkout of ${spec.alias} at ${meta.ref ?? meta.sha}`);
    result = checkoutResult(spec, id, repoDir, meta);
  } else {
    try {
      const wanted = spec.ref ?? (await resolveLatestRef(url));
      ctx.log.debug(`fetching ${url}${wanted ? `#${wanted}` : ''}`);
      await mkdir(dir, { recursive: true });
      if (have) {
        try {
          await updateCheckout(url, repoDir, wanted);
        } catch (e) {
          ctx.log.debug(`update of cached ${spec.alias} failed (${(e as Error).message}); re-cloning`);
          await freshClone(url, repoDir, wanted);
        }
      } else {
        await freshClone(url, repoDir, wanted);
      }
      const sha = (await git(['rev-parse', 'HEAD'], repoDir)).trim();
      const next: CheckoutMeta = { url, requested, sha, fetchedAt: new Date().toISOString() };
      if (wanted) next.ref = wanted;
      await writeFile(metaFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      result = checkoutResult(spec, id, repoDir, next);
    } catch (e) {
      throw toPalmError(e, `Cannot fetch origin "${spec.alias}" from`, url);
    }
  }
  if (spec.root && !existsSync(result.root)) {
    throw new PalmError('E_ORIGIN', `Subdirectory "${spec.root}" not found in ${url}${result.ref ? `@${result.ref}` : ''}`);
  }
  return result;
}
