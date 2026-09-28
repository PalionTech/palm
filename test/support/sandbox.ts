/**
 * Filesystem sandbox helpers shared by all tests: real (symlink-resolved) temp dirs,
 * file writers and readers, and a sandboxed HOME/PALM_HOME/project triple.
 * Nothing here ever touches the real home directory.
 */
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fresh real (symlink-resolved) temp dir; the caller removes it with removeDir(). */
export async function tempDir(prefix = 'palm-test-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

const created: string[] = [];

/** Like tempDir(), but tracked: cleanupTmp() removes every dir created this way. */
export async function tmpDir(prefix = 'palm-targets-'): Promise<string> {
  const dir = await tempDir(prefix);
  created.push(dir);
  return dir;
}

export async function cleanupTmp(): Promise<void> {
  while (created.length) await removeDir(created.pop()!);
}

/** Writes `content` to `file`, creating parent dirs; optionally sets the file mode. */
export async function write(file: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  if (mode !== undefined) await chmod(file, mode);
}

/** Writes each `relative path -> content` pair below `root` (UTF-8). */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/** Writes `root/rel`; objects are written as pretty-printed JSON. */
export async function putFile(root: string, rel: string, content: string | object): Promise<void> {
  await write(
    join(root, rel),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

export async function read(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await read(file));
}

export async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** Fake environment rooted in `home` (never the real one). */
export function fakeEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PALM_HOME: join(home, '.palm'), ...extra };
}

export interface Sandbox {
  root: string;
  home: string;
  palmHome: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

/** Temp HOME, PALM_HOME and a project dir (with .git) — never the real home. */
export async function sandbox(): Promise<Sandbox> {
  const root = await tempDir();
  const home = join(root, 'home');
  const palmHome = join(root, 'palm-home');
  const project = join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  return { root, home, palmHome, project, env: { HOME: home, PALM_HOME: palmHome } };
}
