/**
 * A sandbox for end-to-end engine tests: a temp home, palm home and project, local sources
 * inside the project, fake git remotes with tagged versions, and the fake collaborators of
 * fakes.ts wired as `deps`. Import fakes.ts before this module (it registers the mocks).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type {
  EngineDeps,
  LockEntry,
  Lockfile,
  PalmContext,
  TargetId,
  UI,
} from '../../src/core/types.js';
import { renderHashOf } from '../../src/domain/lock.js';
import {
  type ConsentScript,
  type FakeExec,
  type FakeLogger,
  type FakeSecrets,
  fakeExec,
  fakeScan,
  fakeSecrets,
  fakeTargets,
  fakeUI,
  makeContext,
  remotes,
  type TargetCalls,
} from './fakes.js';

export type Files = Record<string, string | { text: string; mode: number }>;

export async function writeTree(root: string, files: Files): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === 'string' ? content : content.text);
    if (typeof content !== 'string') await chmod(abs, content.mode);
  }
}

export interface WorldOptions {
  /** palm.yaml `targets:` (written before the first command); none: detection. */
  targets?: TargetId[];
  detect?: TargetId[];
  failFor?: TargetId[];
  consent?: ConsentScript;
  interactive?: boolean;
  confirm?: boolean;
  flags?: Partial<PalmContext['flags']>;
}

export class World {
  readonly ctx: PalmContext & { log: FakeLogger };
  readonly deps: Partial<EngineDeps>;
  readonly calls: TargetCalls;

  constructor(
    readonly root: string,
    readonly opts: WorldOptions,
    readonly exec: FakeExec,
    readonly secrets: FakeSecrets,
  ) {
    const targets = fakeTargets({
      detect: opts.detect ?? [],
      failFor: opts.failFor ?? [],
      hash: renderHashOf,
    });
    this.calls = targets.calls;
    this.deps = {
      scan: fakeScan,
      getTarget: targets.getTarget,
      execUnit: exec.execUnit,
      askConsent: exec.askConsent,
      ...secrets,
    };
    this.ctx = this.context(opts.flags ?? {});
  }

  get home(): string {
    return join(this.root, 'home');
  }

  get palmHome(): string {
    return join(this.root, 'palm-home');
  }

  get project(): string {
    return join(this.root, 'project');
  }

  /** A context over the same sandbox with other flags (and optionally another UI). */
  context(flags: Partial<PalmContext['flags']>, ui?: UI): PalmContext & { log: FakeLogger } {
    const u =
      ui ??
      fakeUI({ interactive: this.opts.interactive ?? false, confirm: this.opts.confirm ?? false });
    return makeContext({
      root: this.root,
      home: this.home,
      palmHome: this.palmHome,
      project: this.project,
      flags,
      ui: u,
    });
  }

  /** Files under the project (a local source is `./<dir>`). */
  async local(dir: string, files: Files): Promise<string> {
    await writeTree(join(this.project, dir), files);
    return `./${dir}`;
  }

  /**
   * A fake git remote `https://example.com/<name>.git` with one checkout per ref (tag or
   * branch); returns its URL.
   */
  async remote(name: string, versions: Record<string, Files>, head = 'main'): Promise<string> {
    const url = `https://example.com/${name}.git`;
    const remote = {
      refs: {} as Record<string, string>,
      trees: {} as Record<string, string>,
      head,
    };
    for (const [ref, files] of Object.entries(versions)) {
      const sha = createHash('sha1').update(`${url}#${ref}`).digest('hex');
      const dir = join(this.root, 'remotes', name, sha);
      await writeTree(dir, files);
      remote.refs[ref] = sha;
      remote.trees[sha] = dir;
    }
    remotes.set(url, remote);
    return url;
  }

  path(rel: string): string {
    return join(this.project, rel);
  }

  async read(rel: string): Promise<string | undefined> {
    return readFile(this.path(rel), 'utf8').catch(() => undefined);
  }

  exists(rel: string): boolean {
    return existsSync(this.path(rel));
  }

  async write(rel: string, text: string): Promise<void> {
    await writeTree(this.project, { [rel]: text });
  }

  async remove(rel: string): Promise<void> {
    await rm(this.path(rel), { recursive: true, force: true });
  }

  async manifestText(): Promise<string | undefined> {
    return this.read('palm.yaml');
  }

  async lockText(): Promise<string | undefined> {
    return this.read('palm.lock.yaml');
  }

  async lock(): Promise<Lockfile> {
    return parse((await this.lockText()) ?? 'version: 3\nsources: {}\nentries: []') as Lockfile;
  }

  async entry(kind: string, name: string): Promise<LockEntry | undefined> {
    return (await this.lock()).entries?.find((e) => e.kind === kind && e.name === name);
  }

  async manifest(): Promise<Record<string, unknown>> {
    return (parse((await this.manifestText()) ?? '{}') ?? {}) as Record<string, unknown>;
  }
}

export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'palm-engine-')));
  const w = new World(root, opts, fakeExec(opts.consent ?? 'yes'), fakeSecrets());
  await mkdir(w.home, { recursive: true });
  await mkdir(w.project, { recursive: true });
  if (opts.targets)
    await writeTree(w.project, { 'palm.yaml': `targets: [${opts.targets.join(', ')}]\n` });
  return w;
}

export type { FakeExec, FakeSecrets };
