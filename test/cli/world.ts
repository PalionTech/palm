/**
 * A machine for end-to-end tests of the built CLI: a temp home with its own PALM_HOME, projects
 * that are git repositories, and sources served as local bare git repositories with tags
 * (`file://` URLs), so every command runs the real engine, index, targets, exec and secrets
 * without the network.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { runPalm } from '../support/cli.js';
import { tempDir } from '../support/sandbox.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'palm-test',
  GIT_AUTHOR_EMAIL: 'test@palm.invalid',
  GIT_COMMITTER_NAME: 'palm-test',
  GIT_COMMITTER_EMAIL: 'test@palm.invalid',
  GIT_AUTHOR_DATE: '2026-09-28T12:00:00Z',
  GIT_COMMITTER_DATE: '2026-09-28T12:00:00Z',
  GIT_TERMINAL_PROMPT: '0',
};

export type Files = Record<string, string | { text: string; mode: number }>;

export async function writeFiles(root: string, files: Files): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === 'string' ? content : content.text);
    if (typeof content !== 'string') await chmod(abs, content.mode);
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: GIT_ENV,
  });
  return r.stdout.trim();
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr, stdout first. */
  all: string;
}

export class Machine {
  private constructor(readonly root: string) {}

  static async create(): Promise<Machine> {
    return new Machine(await tempDir('palm-e2e-'));
  }

  get home(): string {
    return join(this.root, 'home');
  }

  get palmHome(): string {
    return join(this.home, '.palm');
  }

  /** A new git project at `<root>/<name>` with the given harness directories. */
  async project(name: string, dirs: string[] = ['.claude']): Promise<string> {
    const dir = join(this.root, name);
    await mkdir(dir, { recursive: true });
    for (const d of dirs) await mkdir(join(dir, d), { recursive: true });
    await git(dir, 'init', '-q');
    return dir;
  }

  /**
   * A source repository `<name>.git` with one commit and tag per version (in order); returns its
   * `file://` URL. Each version's files replace the previous tree.
   */
  async source(name: string, versions: Record<string, Files>): Promise<string> {
    const work = join(this.root, 'src', name);
    await mkdir(work, { recursive: true });
    await git(work, 'init', '-q');
    for (const [tag, files] of Object.entries(versions)) {
      await git(work, 'rm', '-rq', '--ignore-unmatch', '.');
      await writeFiles(work, files);
      await git(work, 'add', '-A');
      await git(work, 'commit', '-qm', tag, '--allow-empty');
      await git(work, 'tag', tag);
    }
    const bare = join(this.root, 'remotes', `${name}.git`);
    await execa('git', ['clone', '-q', '--bare', work, bare], { env: GIT_ENV });
    return `file://${bare}`;
  }

  /** Pushes a new tagged version to a source made by `source`. */
  async release(name: string, tag: string, files: Files): Promise<void> {
    const work = join(this.root, 'src', name);
    await git(work, 'rm', '-rq', '--ignore-unmatch', '.');
    await writeFiles(work, files);
    await git(work, 'add', '-A');
    await git(work, 'commit', '-qm', tag);
    await git(work, 'tag', tag);
    await git(work, 'push', '-q', '--tags', join(this.root, 'remotes', `${name}.git`), 'main');
  }

  /** Runs the built palm in `cwd` as this machine (its HOME and PALM_HOME, no terminal). */
  async palm(cwd: string, ...args: string[]): Promise<Run> {
    const env = {
      HOME: this.home,
      PALM_HOME: this.palmHome,
      CLAUDE_CONFIG_DIR: join(this.home, '.claude'),
      CODEX_HOME: join(this.home, '.codex'),
      COPILOT_HOME: join(this.home, '.copilot'),
      XDG_CONFIG_HOME: join(this.home, '.config'),
      NO_COLOR: '1',
      CI: '1',
    };
    const r = await runPalm(args, { cwd, env });
    const stdout = String(r.stdout ?? '');
    const stderr = String(r.stderr ?? '');
    return { code: r.exitCode ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` };
  }

  async read(file: string): Promise<string> {
    return readFile(file, 'utf8');
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** The `--allow-exec` value on an E_UNTRUSTED_EXEC error's `then:` line. */
export function allowExecOf(output: string): string {
  const m = /then: .*--allow-exec (\S+)/.exec(output);
  if (!m?.[1]) throw new Error(`no --allow-exec line in:\n${output}`);
  return m[1];
}
