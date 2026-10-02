/**
 * E3': a palm killed mid-run leaves its process lock behind; `check` removes it when the pid it
 * names no longer runs on this host, so the file never lingers to be staged by `git add -A`.
 * A lock held by a running process, or by another host, is left alone. The one write `check`
 * makes.
 */
import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes the lock at `file` when a dead process of this host holds it; true when it did. */
export async function removeStaleLock(file: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  let info: { pid?: unknown; host?: unknown };
  try {
    info = JSON.parse(text) as { pid?: unknown; host?: unknown };
  } catch {
    return false;
  }
  if (info.host !== hostname() || typeof info.pid !== 'number' || running(info.pid)) return false;
  await rm(file, { force: true });
  return true;
}
