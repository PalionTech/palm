/**
 * What a person types as a source (`palm install <source> …`) turned into a `Source` with a
 * name (DESIGN.md section 5 "Input forms"): `owner/repo`, `owner/repo/sub/dir`,
 * `github:owner/repo`, an `https://`, `http://`, `git://`, `ssh://` or `file://` URL, a scp-like
 * `user@host:path`, each optionally with `#ref`, or a directory path (`./…`, `../…`, `/…`, `~/…`).
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { SourceRef, sourceNameKind } from '../domain/source.js';
import {
  expandTilde,
  GITHUB_REPO,
  githubRepoOf,
  githubUrl,
  SCP_LIKE,
  stripGit,
  trimSlashes,
  URL_SCHEME,
  validateSourceUrl,
} from '../domain/source-url.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { PalmError } from './errors.js';
import type { LayoutDescriptor, Source } from './types.js';

export { validateSourceUrl } from '../domain/source-url.js';

/** A source as parsed from input, before it has a name. */
type Parsed = Omit<Source, 'name'>;

/** One input: `raw` as typed, `body` and `ref` split at the last `#`. */
interface Input {
  raw: string;
  body: string;
  ref?: string;
  cwd: string;
}

const PREFIXED = /^(github|gitlab):(.+)$/i;
const SHORTHAND = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)((?:\/[^/\s#]+)*)\/?$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isBareRepo(p: string): boolean {
  return existsSync(join(p, 'HEAD')) && isDir(join(p, 'objects')) && !existsSync(join(p, '.git'));
}

/** `./x`, `../x`, `/x`, `~`, `~/x`, `.` and `..`: a path, never a repository name. */
function isExplicitPath(raw: string): boolean {
  if (raw === '.' || raw === '..' || raw === '~') return true;
  return isAbsolute(raw) || ['./', '../', '~/'].some((p) => raw.startsWith(p));
}

function withRef(spec: Parsed, ref: string | undefined): Parsed {
  return ref ? { ...spec, ref } : spec;
}

function withRoot(spec: Parsed, root: string | undefined): Parsed {
  return root ? { ...spec, root } : spec;
}

/** `owner/repo[/tree|blob/<ref>][/sub/dir]` on github.com. */
function githubSpec(owner: string, repo: string, rest: string[], ref?: string): Parsed {
  const [mode, treeRef, ...dirs] = rest;
  const tree = (mode === 'tree' || mode === 'blob') && !!treeRef;
  const root = tree ? dirs.join('/') : rest.join('/');
  const spec: Parsed = { type: 'git', url: githubUrl(`${owner}/${repo}`) };
  return withRoot(withRef(spec, ref ?? (tree ? treeRef : undefined)), root);
}

function parseLocal({ raw, body, ref, cwd }: Input): Parsed {
  const path = resolve(cwd, expandTilde(body));
  if (!existsSync(path))
    throw new PalmError(
      'E_SOURCE',
      `no directory at ${path}`,
      `check the path, then run palm install ${raw}`,
    );
  if (!isDir(path))
    throw new PalmError(
      'E_SOURCE',
      `${path} is not a directory`,
      'a local source is a directory, for example ./agent-kit',
    );
  if (isBareRepo(path)) return withRef({ type: 'git', url: path }, ref);
  if (ref)
    throw new PalmError(
      'E_SOURCE',
      `a directory has no refs (${raw})`,
      `use file://${path}#${ref} for a tagged checkout`,
    );
  return { type: 'local', path };
}

function parsePrefixed({ raw, body, ref }: Input): Parsed {
  const [, host = '', rest = ''] = PREFIXED.exec(body) ?? [];
  const [owner, repo, ...sub] = trimSlashes(rest).split('/').filter(Boolean);
  if (!owner || !repo)
    throw new PalmError(
      'E_SOURCE',
      `"${raw}" needs an owner and a repository`,
      'palm install github:owner/repo',
    );
  if (host.toLowerCase() === 'github') return githubSpec(owner, repo, sub, ref);
  const segs = [owner, repo, ...sub].map(stripGit);
  return withRef({ type: 'git', url: `https://gitlab.com/${segs.join('/')}.git` }, ref);
}

/** Non-GitHub URLs: GitLab-style `/-/tree/<ref>/<dir>` is understood; anything else is the repo. */
function otherHostSpec(u: URL, body: string, segs: string[], ref?: string): Parsed {
  let url = body.replace(/\/+$/, '');
  let root: string | undefined;
  let treeRef: string | undefined;
  const dash = segs.indexOf('-');
  const mode = segs[dash + 1];
  if (dash > 0 && (mode === 'tree' || mode === 'blob') && segs[dash + 2]) {
    treeRef = segs[dash + 2];
    root = segs.slice(dash + 3).join('/');
    url = `${u.protocol}//${u.host}/${segs.slice(0, dash).join('/')}`;
  }
  if (u.hostname.toLowerCase() === 'gitlab.com' && !/\.git$/i.test(url)) url = `${url}.git`;
  return withRoot(withRef({ type: 'git', url }, ref ?? treeRef), root);
}

function parseUrl({ body, ref }: Input): Parsed {
  let u: URL;
  try {
    u = new URL(body);
  } catch {
    throw new PalmError(
      'E_SOURCE',
      `"${body}" is not a valid URL`,
      'palm install https://host/owner/repo.git',
    );
  }
  if (u.protocol === 'file:') return withRef({ type: 'git', url: body }, ref);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = u.hostname.toLowerCase();
  const githubWeb =
    (host === 'github.com' || host === 'www.github.com') &&
    !u.username &&
    (u.protocol === 'https:' || u.protocol === 'http:');
  if (!githubWeb) return otherHostSpec(u, body, segs, ref);
  const [owner, repo, ...rest] = segs;
  if (!owner || !repo)
    throw new PalmError(
      'E_SOURCE',
      `"${body}" needs an owner and a repository`,
      'palm install owner/repo',
    );
  return githubSpec(owner, repo, rest, ref);
}

function parseScp({ body, ref }: Input): Parsed {
  const [, user = '', host = '', path = ''] = SCP_LIKE.exec(body) ?? [];
  const [owner, repo, ...sub] = trimSlashes(path).split('/').filter(Boolean);
  if (host.toLowerCase() !== 'github.com' || !owner || !repo)
    return withRef({ type: 'git', url: body }, ref);
  const url = `${user}@github.com:${owner}/${stripGit(repo)}.git`;
  return withRef(withRoot({ type: 'git', url }, sub.join('/')), ref);
}

function parseShorthand({ body, ref }: Input): Parsed {
  const [, owner = '', repo = '', rest = ''] = SHORTHAND.exec(body) ?? [];
  return githubSpec(owner, repo, rest.split('/').filter(Boolean), ref);
}

type Matcher = readonly [test: (input: Input) => boolean, parse: (input: Input) => Parsed];

/** First match wins: a path, `github:`/`gitlab:`, a URL, scp-like, `owner/repo[/sub/dir]`. */
const MATCHERS: readonly Matcher[] = [
  [({ body }) => isExplicitPath(body), parseLocal],
  [({ body }) => PREFIXED.test(body), parsePrefixed],
  [({ body }) => URL_SCHEME.test(body), parseUrl],
  [({ body }) => SCP_LIKE.test(body), parseScp],
  [({ body }) => SHORTHAND.test(body), parseShorthand],
];

function splitInput(raw: string, cwd: string): Input {
  const h = raw.lastIndexOf('#');
  if (h < 0) return { raw, body: raw, cwd };
  return { raw, body: raw.slice(0, h), ref: raw.slice(h + 1).trim() || undefined, cwd };
}

/** E_USAGE for a word that is none of the input forms: its first line is the fix (DESIGN.md section 10). */
function notARepository(word: string): PalmError {
  const search = `https://github.com/search?q=${encodeURIComponent(word)}+SKILL.md&type=code`;
  return new PalmError(
    'E_USAGE',
    `"${word}" is not a repository. palm installs from git repositories:`,
    `palm install <owner/repo> [names...]      for example  palm install obra/superpowers\nNot sure which repository? ${search}`,
  );
}

/** True when `word` has one of the input forms (a path, `github:`, a URL, scp-like, `owner/repo`), `#ref` aside. */
export function looksLikeSourceInput(word: string): boolean {
  const input = splitInput(word.trim(), '.');
  return input.body !== '' && MATCHERS.some(([test]) => test(input));
}

/** `./rel` of a local directory from the project root (`.` for the root itself); outside it is E_SOURCE. */
function localName(path: string, projectRoot: string): string {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const [abs, root] = [real(path), real(projectRoot)];
  if (!isWithin(abs, root))
    throw new PalmError(
      'E_SOURCE',
      `${path} is outside the project ${projectRoot}; a local source is a directory inside it`,
      'move the directory into the project, or publish it as a git repository and palm install its URL',
    );
  const rel = toPosix(relative(root, abs));
  return rel ? `./${rel}` : '.';
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?$/;

/**
 * A user-supplied source as a `Source`: local paths absolute (named `./rel` from
 * `projectRoot`; outside it E_SOURCE), URLs validated (E_SOURCE), `#ref` (or `opts.ref`) as the
 * ref, `opts.root`/`opts.layout` applied, the name `opts.as` or derived (`deriveSourceName`).
 * A bare word that is none of the forms is E_USAGE whose first line is the fix.
 */
export function parseSourceInput(input: string, opts: ParseSourceOptions = {}): Source {
  const raw = input.trim();
  const cwd = opts.cwd ?? process.cwd();
  const inputParts = splitInput(raw, cwd);
  const matcher = raw ? MATCHERS.find(([test]) => test(inputParts)) : undefined;
  if (!matcher) throw notARepository(raw);
  const parsed = withOptions(matcher[1](inputParts), opts);
  if (parsed.type === 'git') validateSourceUrl(parsed.url ?? '', `source "${raw}"`);
  if (opts.as !== undefined && !NAME_RE.test(opts.as))
    throw new PalmError(
      'E_USAGE',
      `"${opts.as}" is not a source name`,
      'a name is letters, digits, ".", "_" and "-", for example --as kit',
    );
  const local =
    parsed.type === 'local' ? localName(parsed.path ?? cwd, opts.projectRoot ?? cwd) : undefined;
  const name = opts.as ?? local ?? deriveSourceName({ ...parsed, name: '' }, []);
  return { name, ...parsed };
}

/** `parsed` with the ref, root and layout the options set. */
function withOptions(parsed: Parsed, opts: ParseSourceOptions): Parsed {
  const out: Parsed = { ...parsed };
  if (opts.ref) out.ref = opts.ref;
  if (opts.root) out.root = trimSlashes(opts.root);
  if (!out.root) delete out.root;
  if (opts.layout) out.layout = opts.layout;
  return out;
}

export interface ParseSourceOptions {
  /** The name to declare the source under (`--as`). */
  as?: string;
  ref?: string;
  root?: string;
  layout?: LayoutDescriptor;
  /** Base for relative paths (default: process.cwd()). */
  cwd?: string;
  /** The scope root local paths must lie in, and are named relative to (default: `cwd`). */
  projectRoot?: string;
}

/** Name candidates for a git source, best first. */
function nameCandidates(source: Source): string[] {
  const repo = githubRepoOf(source.url ?? '');
  const parts = new SourceRef(source).repoParts();
  const clean = (s: string) =>
    s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+|-+$/g, '');
  const out = [
    ...(repo && GITHUB_REPO.test(repo) ? [repo] : []),
    clean(parts.repo),
    parts.owner ? clean(`${parts.owner}-${parts.repo}`) : '',
  ].filter(Boolean);
  return out.length ? [...new Set(out)] : ['source'];
}

/**
 * The manifest key for a source not declared yet (DESIGN.md section 5): `owner/repo` for a
 * GitHub repository, else `repo`, else `owner-repo`, else the last of those with `-2`, `-3`, …;
 * never one of `existing` (compared case-insensitively). A local source keeps its `./rel` name
 * (a path names one directory), or gets `./<basename>`.
 */
export function deriveSourceName(source: Source, existing: readonly string[]): string {
  if (source.type === 'local') {
    return sourceNameKind(source.name) === 'local'
      ? source.name
      : `./${basename(source.path ?? 'local')}`;
  }
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const candidates = nameCandidates(source);
  const free = candidates.find((c) => !taken.has(c.toLowerCase()));
  if (free) return free;
  const base = candidates[candidates.length - 1] as string;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
}
