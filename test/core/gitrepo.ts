import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

const GIT = ['-c', 'user.name=palm-test', '-c', 'user.email=test@palm.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', [...GIT, ...args], { cwd, env: { GIT_TERMINAL_PROMPT: '0' } });
  return r.stdout.trim();
}

export async function commitFile(work: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(work, file), content);
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

/**
 * A work repo with tags v1.0.0, v1.1.0, a prerelease v2.0.0-beta.1 and an
 * untagged main head, pushed to a bare "remote".
 */
export async function makeRemote(root: string): Promise<{ work: string; bare: string; shas: Record<string, string> }> {
  const work = join(root, 'work');
  const bare = join(root, 'remote.git');
  await execa('git', ['init', '-q', '-b', 'main', work]);
  const shas: Record<string, string> = {};
  shas['v1.0.0'] = await commitFile(work, 'a.txt', 'v1.0.0', 'one');
  await git(work, 'tag', 'v1.0.0');
  shas['v1.1.0'] = await commitFile(work, 'a.txt', 'v1.1.0', 'two');
  await git(work, 'tag', 'v1.1.0');
  shas['v2.0.0-beta.1'] = await commitFile(work, 'a.txt', 'beta', 'three');
  await git(work, 'tag', 'v2.0.0-beta.1');
  shas.main = await commitFile(work, 'a.txt', 'main', 'four');
  await execa('git', ['clone', '-q', '--bare', work, bare]);
  return { work, bare, shas };
}
