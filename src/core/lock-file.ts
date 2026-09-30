/**
 * The advisory lock two palm processes serialise on (DESIGN.md section 2): one fetch per
 * checkout, one writer per scope. O_EXCL create with pid and host inside, heartbeat on the
 * mtime, stale after 10 minutes or a dead pid on this host, 60 s wait.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errnoCode, isEnoent } from '../lib/fs.js';
import { deniedError, PalmError } from './errors.js';

/** A lock whose mtime is older than this is abandoned, whoever holds it. */
const LOCK_STALE_MS = 10 * 60_000;
/** How often a holder refreshes its lock's mtime. */
const LOCK_HEARTBEAT_MS = 60_000;
/** How long a caller waits for another palm process before giving up. */
const LOCK_TIMEOUT_MS = 60_000;

interface LockInfo {
  pid: number;
  host: string;
  createdAt: string;
}

export interface LockOptions {
  /** Give up after this long (default 60 s). */
  timeoutMs?: number;
  /** Treat a lock untouched for this long as abandoned (default 10 min). */
  staleMs?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

function parseLockInfo(text: string): Partial<LockInfo> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Partial<LockInfo>) : {};
  } catch {
    return {}; // being written right now, or garbage: judged by its mtime
  }
}

/** Creates `file` exclusively (O_EXCL) and returns what it wrote; undefined when it exists. */
async function tryCreateLock(file: string): Promise<LockInfo | undefined> {
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(file, `${JSON.stringify(info)}\n`, { flag: 'wx' });
    return info;
  } catch (e) {
    // EEXIST: held; ENOENT: its directory went with the last holder (the caller recreates it).
    if (errnoCode(e) === 'EEXIST' || errnoCode(e) === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * The current holder of `file`, or undefined when the lock is gone, untouched for `staleMs`
 * (holders refresh its mtime while they work), or held by a process of this host that no longer
 * runs (a palm killed mid-run). Such a lock is removed.
 */
async function liveHolder(file: string, staleMs: number): Promise<Partial<LockInfo> | undefined> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, { mtimeMs }] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
  const info = parseLockInfo(text);
  const dead = info.host === hostname() && typeof info.pid === 'number' && !processAlive(info.pid);
  if (!dead && Date.now() - mtimeMs <= staleMs) return info;
  await rm(file, { force: true });
  return undefined;
}

function lockTimeout(file: string, holder: Partial<LockInfo>, timeoutMs: number): PalmError {
  const by = holder.pid
    ? ` (held by pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''})`
    : '';
  return new PalmError(
    'E_IO',
    `timed out after ${Math.round(timeoutMs / 1000)} s waiting for the lock ${file}${by}`,
    `another palm process is working here; run the command again when it is done, or delete ${file} if none is running`,
  );
}

async function acquireLock(file: string, opts: LockOptions): Promise<LockInfo> {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (let delay = 25; ; delay = Math.min(delay * 2, 1000)) {
    // Each try: the holder that just left may have removed the directory it created.
    await mkdir(dirname(file), { recursive: true });
    const mine = await tryCreateLock(file);
    if (mine) return mine;
    const holder = await liveHolder(file, opts.staleMs ?? LOCK_STALE_MS);
    if (holder && Date.now() >= deadline) throw lockTimeout(file, holder, timeoutMs);
    if (holder) await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
  }
}

/** Signals that end palm without `exit` handlers running (a closed terminal, `kill`). */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGTERM'];

/**
 * Y7: the lock also goes when the process exits while holding it (a Ctrl-C at a prompt ends the
 * process before `finally` runs), and M16: when a closed terminal (SIGHUP) or `kill` (SIGTERM)
 * ends it; the signal is then raised again, so palm ends as it would have. Returns the function
 * that stops watching.
 */
function releaseOnExit(file: string, mine: LockInfo): () => void {
  const release = () => {
    try {
      const now = parseLockInfo(readFileSync(file, 'utf8'));
      if (now.pid === mine.pid && now.createdAt === mine.createdAt) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    release();
    for (const s of ENDING_SIGNALS) process.removeListener(s, onSignal);
    process.kill(process.pid, signal);
  };
  process.once('exit', release);
  for (const s of ENDING_SIGNALS) process.on(s, onSignal);
  return () => {
    process.removeListener('exit', release);
    for (const s of ENDING_SIGNALS) process.removeListener(s, onSignal);
  };
}

/** Removes `file` if it is still the lock described by `mine` (it was not taken over as stale). */
async function releaseLock(file: string, mine: LockInfo): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const now = parseLockInfo(text);
  if (now.pid === mine.pid && now.createdAt === mine.createdAt) await rm(file, { force: true });
}

/**
 * Runs `fn` holding the advisory lock `file` (pid, host and timestamp, created with O_EXCL, its
 * mtime refreshed every minute while `fn` runs). Waits with backoff while another process holds
 * it (default up to 60 s, then E_IO with a hint); a lock untouched for 10 min, or held by a dead
 * process on this host, is taken over.
 */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  // B6: a directory palm may not write (a read-only PALM_HOME or project) is E_IO naming it.
  const mine = await acquireLock(file, opts).catch((e: unknown) => {
    throw deniedError(e, dirname(file)) ?? e;
  });
  const unwatch = releaseOnExit(file, mine);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    unwatch();
    await releaseLock(file, mine);
  }
}
